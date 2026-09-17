"""Offline materialization of the one approved rod Chromium archive; no launch."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile

ARCHIVE_SHA256 = "4a478b542f1f6eaa160e64aab76100501e061d3bba46f6a480897ef1103c70c5"
TREE_SHA256 = "72ef0509da5743313a39ed6933406348f107785f0e04a238fa66949b77edf404"
FRAMEWORK = "Chromium.app/Contents/Frameworks/Chromium Framework.framework/"
LINKS = {
    FRAMEWORK + "Versions/Current": "128.0.6568.0",
    FRAMEWORK + "Resources": "Versions/Current/Resources",
    FRAMEWORK + "Libraries": "Versions/Current/Libraries",
    FRAMEWORK + "Helpers": "Versions/Current/Helpers",
    FRAMEWORK + "Chromium Framework": "Versions/Current/Chromium Framework",
}


def canonical(path):
    parts = path.split("/")
    return (len(path) < 1024 and len(parts) <= 32
            and all(part and part not in (".", "..") and part == part.strip(" ") for part in parts)
            and "  " not in path and all(32 <= ord(c) <= 126 for c in path))


def resolve_alias(path):
    for _ in range(8):
        match = next((name for name in LINKS if path == name or path.startswith(name + "/")), None)
        if match is None:
            return path
        path = str(PurePosixPath(match).parent / LINKS[match]) + path[len(match):]
    raise ValueError()


def main():
    if os.getuid() == 0 or len(sys.argv) != 5 or sys.argv[1] != "--archive" or sys.argv[3] != "--output-dir":
        raise ValueError()
    archive, output = (Path(sys.argv[i]) for i in (2, 4))
    for path in (archive, output):
        if not path.is_absolute() or str(path) != os.path.normpath(str(path)):
            raise ValueError()
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 256 * 1024 * 1024:
            raise ValueError()
        digest = hashlib.sha256()
        snapshot = io.BytesIO()
        total = 0
        while chunk := source.read(1024 * 1024):
            total += len(chunk)
            if total > 256 * 1024 * 1024:
                raise ValueError()
            digest.update(chunk)
            snapshot.write(chunk)
        if digest.hexdigest() != ARCHIVE_SHA256:
            raise ValueError()
        snapshot.seek(0)
        with zipfile.ZipFile(snapshot) as zipped:
            files, links, seen = {}, {}, set()
            if len(zipped.infolist()) != 308:
                raise ValueError()
            for member in zipped.infolist():
                if not member.filename.startswith("chrome-mac/"):
                    raise ValueError()
                name = member.filename[len("chrome-mac/"):].rstrip("/")
                if not canonical(name) or name in seen:
                    raise ValueError()
                seen.add(name)
                mode = member.external_attr >> 16
                if stat.S_ISLNK(mode):
                    if member.file_size > 128:
                        raise ValueError()
                    links[name] = zipped.read(member).decode("ascii")
                elif stat.S_ISREG(mode):
                    if member.file_size > 256 * 1024 * 1024:
                        raise ValueError()
                    files[name] = member
                elif not stat.S_ISDIR(mode):
                    raise ValueError()
            if links != LINKS:
                raise ValueError()
            # Expand the five authenticated internal aliases from original files.
            # No symlink is ever created or followed in the destination tree.
            expanded = dict(files)
            for alias in LINKS:
                target = resolve_alias(alias)
                matches = [(name, member) for name, member in files.items()
                           if name == target or name.startswith(target + "/")]
                if not matches:
                    raise ValueError()
                for name, member in matches:
                    destination = alias + name[len(target):]
                    if destination in expanded or not canonical(destination):
                        raise ValueError()
                    expanded[destination] = member
            if len(expanded) > 20000 or sum(m.file_size for m in expanded.values()) > 2 * 1024**3:
                raise ValueError()
            output.mkdir(mode=0o700)  # Exclusive; retain partial output on error.
            entries, directories = [], set()
            for name, member in sorted(expanded.items()):
                path = output / name
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                parent = PurePosixPath(name).parent
                while str(parent) != ".":
                    directories.add(str(parent))
                    parent = parent.parent
                mode = 0o755 if (member.external_attr >> 16) & 0o111 else 0o644
                digest, size = hashlib.sha256(), 0
                with zipped.open(member) as src, path.open("xb") as dst:
                    while chunk := src.read(1024 * 1024):
                        size += len(chunk)
                        if size > member.file_size:
                            raise ValueError()
                        digest.update(chunk)
                        dst.write(chunk)
                if size != member.file_size:
                    raise ValueError()
                path.chmod(mode)
                entries.append(dict(path=name, kind="file", mode=mode, size=size, sha256=digest.hexdigest()))
            for directory in directories:
                (output / directory).chmod(0o755)
                entries.append(dict(path=directory, kind="directory", mode=0o755))
            entries.sort(key=lambda entry: entry["path"])
            tree_bytes = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
            if hashlib.sha256(tree_bytes).hexdigest() != TREE_SHA256:
                raise ValueError()
            print(json.dumps(dict(schemaVersion=1, kind="offline_chromium_artifact",
                                  revision=1321438, archiveSha256=ARCHIVE_SHA256,
                                  treeSha256=hashlib.sha256(tree_bytes).hexdigest(),
                                  hostAcceptance=False, entries=entries), separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write("chromium_artifact_unavailable\n")
        sys.exit(1)
