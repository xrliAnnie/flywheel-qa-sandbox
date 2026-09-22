#include <node_api.h>

#ifdef __APPLE__
#include <bsm/libbsm.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <cstdint>
#include <cstring>
#include <map>
#include <string>
#include <utility>
#endif

namespace {

constexpr uint32_t kAbiVersion = 2;

napi_value Throw(napi_env env, const char* code, const std::string& detail) {
  napi_value message;
  napi_create_string_utf8(env, detail.c_str(), detail.size(), &message);
  napi_value error;
  napi_create_error(env, nullptr, message, &error);
  napi_value code_value;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value);
  napi_set_named_property(env, error, "code", code_value);
  napi_throw(env, error);
  return nullptr;
}

napi_value Uint32(napi_env env, uint32_t value) {
  napi_value result;
  napi_create_uint32(env, value, &result);
  return result;
}

napi_value String(napi_env env, const std::string& value) {
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

napi_value Bool(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

bool Set(napi_env env, napi_value object, const char* name, napi_value value) {
  return napi_set_named_property(env, object, name, value) == napi_ok;
}

bool OneUint32(napi_env env, napi_callback_info info, uint32_t* value) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc != 1) {
    return false;
  }
  return napi_get_value_uint32(env, argv[0], value) == napi_ok;
}

bool Utf8(napi_env env, napi_value value, std::string* output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length > 65536) {
    return false;
  }
  std::string bytes(length + 1, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, bytes.data(), length + 1,
                                 &copied) != napi_ok ||
      copied != length) {
    return false;
  }
  bytes.resize(length);
  *output = std::move(bytes);
  return true;
}

napi_value AbiVersion(napi_env env, napi_callback_info) {
  return Uint32(env, kAbiVersion);
}

#ifdef __APPLE__

// Pinned from Apple XNU bsd/sys/proc_info_private.h. Startup/build self-tests
// fail closed unless the kernel returns this exact 56-byte ABI.
struct ProcUniqueIdentifierInfo {
  uint8_t executable_uuid[16];
  uint64_t unique_id;
  uint64_t parent_unique_id;
  int32_t pid_version;
  int32_t original_parent_pid_version;
  uint64_t reserved2;
  uint64_t reserved3;
};
static_assert(sizeof(ProcUniqueIdentifierInfo) == 56,
              "XNU proc unique identifier ABI drift");
constexpr int kProcPidUniqueIdentifierInfo = 17;

struct ProcessSnapshot {
  pid_t pid = 0;
  pid_t parent_pid = 0;
  uid_t uid = 0;
  uint64_t start_seconds = 0;
  uint64_t start_microseconds = 0;
  uint64_t unique_id = 0;
  uint64_t parent_unique_id = 0;
  int32_t pid_version = 0;
  int32_t original_parent_pid_version = 0;
};

struct PeerSnapshot {
  ProcessSnapshot process;
  uid_t effective_uid = 0;
  gid_t effective_gid = 0;
  int32_t audit_pid_version = 0;
};

enum class HandleKind { kListener, kConnection };
struct Handle {
  HandleKind kind;
  int fd;
  std::string path;
  dev_t device = 0;
  ino_t inode = 0;
  std::string input;
  PeerSnapshot initial_peer;
};

std::map<uint32_t, Handle> handles;
uint32_t next_handle = 1;

std::string Errno(const char* operation) {
  return std::string(operation) + ": " + std::strerror(errno);
}

bool SetCloseOnExecAndNonBlocking(int fd) {
  int fd_flags = fcntl(fd, F_GETFD);
  int status_flags = fcntl(fd, F_GETFL);
  int no_sigpipe = 1;
  return fd_flags >= 0 && status_flags >= 0 &&
         setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe,
                    sizeof(no_sigpipe)) == 0 &&
         fcntl(fd, F_SETFD, fd_flags | FD_CLOEXEC) == 0 &&
         fcntl(fd, F_SETFL, status_flags | O_NONBLOCK) == 0;
}

bool ReadProcess(pid_t pid, ProcessSnapshot* output, std::string* error) {
  struct proc_bsdinfo bsd = {};
  const int bsd_bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd,
                                    static_cast<int>(sizeof(bsd)));
  if (bsd_bytes != static_cast<int>(sizeof(bsd)) ||
      bsd.pbi_pid != static_cast<uint32_t>(pid)) {
    *error = "peer_identity_unavailable:proc_bsdinfo";
    return false;
  }
  ProcUniqueIdentifierInfo unique = {};
  const int unique_bytes = proc_pidinfo(
      pid, kProcPidUniqueIdentifierInfo, 0, &unique,
      static_cast<int>(sizeof(unique)));
  if (unique_bytes != static_cast<int>(sizeof(unique)) || unique.unique_id == 0 ||
      unique.pid_version <= 0) {
    *error = "peer_identity_unavailable:proc_unique_identifier";
    return false;
  }
  output->pid = pid;
  output->parent_pid = static_cast<pid_t>(bsd.pbi_ppid);
  output->uid = bsd.pbi_uid;
  output->start_seconds = bsd.pbi_start_tvsec;
  output->start_microseconds = bsd.pbi_start_tvusec;
  output->unique_id = unique.unique_id;
  output->parent_unique_id = unique.parent_unique_id;
  output->pid_version = unique.pid_version;
  output->original_parent_pid_version = unique.original_parent_pid_version;
  return true;
}

bool ReadPeer(int fd, PeerSnapshot* output, std::string* error) {
  pid_t peer_pid = 0;
  socklen_t pid_size = sizeof(peer_pid);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peer_pid, &pid_size) != 0 ||
      pid_size != sizeof(peer_pid) || peer_pid <= 0) {
    *error = Errno("peer_identity_unavailable:LOCAL_PEERPID");
    return false;
  }
  audit_token_t token = {};
  socklen_t token_size = sizeof(token);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &token_size) != 0 ||
      token_size != sizeof(token) || audit_token_to_pid(token) != peer_pid) {
    *error = Errno("peer_identity_unavailable:LOCAL_PEERTOKEN");
    return false;
  }
  if (!ReadProcess(peer_pid, &output->process, error)) return false;
  output->effective_uid = audit_token_to_euid(token);
  output->effective_gid = audit_token_to_egid(token);
  output->audit_pid_version = audit_token_to_pidversion(token);
  if (output->effective_uid != output->process.uid ||
      output->audit_pid_version != output->process.pid_version) {
    *error = "peer_identity_unavailable:audit_process_mismatch";
    return false;
  }
  return true;
}

bool SameProcess(const ProcessSnapshot& left, const ProcessSnapshot& right) {
  return left.pid == right.pid && left.parent_pid == right.parent_pid &&
         left.uid == right.uid && left.start_seconds == right.start_seconds &&
         left.start_microseconds == right.start_microseconds &&
         left.unique_id == right.unique_id &&
         left.parent_unique_id == right.parent_unique_id &&
         left.pid_version == right.pid_version &&
         left.original_parent_pid_version == right.original_parent_pid_version;
}

bool SamePeer(const PeerSnapshot& left, const PeerSnapshot& right) {
  return SameProcess(left.process, right.process) &&
         left.effective_uid == right.effective_uid &&
         left.effective_gid == right.effective_gid &&
         left.audit_pid_version == right.audit_pid_version;
}

napi_value ProcessObject(napi_env env, const ProcessSnapshot& snapshot) {
  napi_value object;
  napi_create_object(env, &object);
  Set(env, object, "pid", Uint32(env, static_cast<uint32_t>(snapshot.pid)));
  Set(env, object, "parentPid",
      Uint32(env, static_cast<uint32_t>(snapshot.parent_pid)));
  Set(env, object, "uid", Uint32(env, static_cast<uint32_t>(snapshot.uid)));
  Set(env, object, "startSeconds",
      String(env, std::to_string(snapshot.start_seconds)));
  Set(env, object, "startMicroseconds",
      Uint32(env, static_cast<uint32_t>(snapshot.start_microseconds)));
  Set(env, object, "uniqueId", String(env, std::to_string(snapshot.unique_id)));
  Set(env, object, "parentUniqueId",
      String(env, std::to_string(snapshot.parent_unique_id)));
  Set(env, object, "pidVersion",
      Uint32(env, static_cast<uint32_t>(snapshot.pid_version)));
  Set(env, object, "originalParentPidVersion",
      Uint32(env,
             static_cast<uint32_t>(snapshot.original_parent_pid_version)));
  return object;
}

napi_value PeerObject(napi_env env, const PeerSnapshot& snapshot) {
  napi_value object = ProcessObject(env, snapshot.process);
  Set(env, object, "effectiveUid",
      Uint32(env, static_cast<uint32_t>(snapshot.effective_uid)));
  Set(env, object, "effectiveGid",
      Uint32(env, static_cast<uint32_t>(snapshot.effective_gid)));
  Set(env, object, "auditPidVersion",
      Uint32(env, static_cast<uint32_t>(snapshot.audit_pid_version)));
  return object;
}

Handle* Find(uint32_t id, HandleKind kind) {
  auto iterator = handles.find(id);
  if (iterator == handles.end() || iterator->second.kind != kind) return nullptr;
  return &iterator->second;
}

uint32_t Insert(Handle handle) {
  while (next_handle == 0 || handles.count(next_handle) != 0) ++next_handle;
  const uint32_t id = next_handle++;
  handles.emplace(id, std::move(handle));
  return id;
}

napi_value CreateListener(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc != 1) {
    return Throw(env, "peer_socket_invalid", "socket path required");
  }
  std::string path;
  if (!Utf8(env, argv[0], &path) || path.empty() || path.front() != '/' ||
      path.find('\0') != std::string::npos ||
      path.size() >= sizeof(((sockaddr_un*)nullptr)->sun_path)) {
    return Throw(env, "peer_socket_invalid", "invalid absolute socket path");
  }
  struct stat existing = {};
  if (lstat(path.c_str(), &existing) == 0 || errno != ENOENT) {
    return Throw(env, "peer_socket_exists", "refusing existing socket path");
  }
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return Throw(env, "peer_adapter_unavailable", Errno("socket"));
  if (!SetCloseOnExecAndNonBlocking(fd)) {
    const std::string detail = Errno("fcntl");
    close(fd);
    return Throw(env, "peer_adapter_unavailable", detail);
  }
  sockaddr_un address = {};
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
  if (bind(fd, reinterpret_cast<sockaddr*>(&address), SUN_LEN(&address)) != 0 ||
      chmod(path.c_str(), 0600) != 0 || listen(fd, 8) != 0) {
    const std::string detail = Errno("bind/listen");
    close(fd);
    struct stat partial = {};
    if (lstat(path.c_str(), &partial) == 0 && S_ISSOCK(partial.st_mode) &&
        partial.st_uid == geteuid()) {
      unlink(path.c_str());
    }
    return Throw(env, "peer_adapter_unavailable", detail);
  }
  struct stat socket_stat = {};
  if (lstat(path.c_str(), &socket_stat) != 0 ||
      !S_ISSOCK(socket_stat.st_mode) || socket_stat.st_uid != geteuid() ||
      (socket_stat.st_mode & 0777) != 0600) {
    close(fd);
    unlink(path.c_str());
    return Throw(env, "peer_adapter_unavailable",
                 "socket post-bind identity mismatch");
  }
  return Uint32(env, Insert(Handle{HandleKind::kListener, fd, path,
                                   socket_stat.st_dev, socket_stat.st_ino}));
}

napi_value Accept(napi_env env, napi_callback_info info) {
  uint32_t listener_id = 0;
  if (!OneUint32(env, info, &listener_id))
    return Throw(env, "peer_handle_invalid", "listener handle required");
  Handle* listener = Find(listener_id, HandleKind::kListener);
  if (!listener)
    return Throw(env, "peer_handle_invalid", "listener handle is not active");
  int fd = accept(listener->fd, nullptr, nullptr);
  if (fd < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
    napi_value null_value;
    napi_get_null(env, &null_value);
    return null_value;
  }
  if (fd < 0) return Throw(env, "peer_accept_failed", Errno("accept"));
  if (!SetCloseOnExecAndNonBlocking(fd)) {
    const std::string detail = Errno("fcntl");
    close(fd);
    return Throw(env, "peer_accept_failed", detail);
  }
  PeerSnapshot snapshot;
  std::string error;
  if (!ReadPeer(fd, &snapshot, &error)) {
    close(fd);
    return Throw(env, "peer_identity_unavailable", error);
  }
  return Uint32(env, Insert(
                         Handle{HandleKind::kConnection, fd, "", 0, 0, "",
                                snapshot}));
}

napi_value ReadFrame(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc != 2) {
    return Throw(env, "peer_frame_invalid", "handle and limit required");
  }
  uint32_t connection_id = 0, limit = 0;
  if (napi_get_value_uint32(env, argv[0], &connection_id) != napi_ok ||
      napi_get_value_uint32(env, argv[1], &limit) != napi_ok || limit == 0 ||
      limit > 65536) {
    return Throw(env, "peer_frame_invalid", "invalid handle or limit");
  }
  Handle* connection = Find(connection_id, HandleKind::kConnection);
  if (!connection)
    return Throw(env, "peer_handle_invalid", "connection handle is not active");
  char buffer[4096];
  for (;;) {
    const ssize_t bytes = recv(connection->fd, buffer, sizeof(buffer), 0);
    if (bytes > 0) {
      connection->input.append(buffer, static_cast<size_t>(bytes));
      if (connection->input.size() > limit)
        return Throw(env, "request_too_large", "peer request exceeded limit");
      continue;
    }
    if (bytes == 0 && connection->input.find('\n') == std::string::npos)
      return Throw(env, "request_incomplete", "peer closed before newline");
    if (bytes < 0 && errno == EINTR) continue;
    if (bytes < 0 && errno != EAGAIN && errno != EWOULDBLOCK)
      return Throw(env, "peer_read_failed", Errno("recv"));
    break;
  }
  const size_t newline = connection->input.find('\n');
  napi_value result;
  napi_create_object(env, &result);
  if (newline == std::string::npos) {
    Set(env, result, "complete", Bool(env, false));
    return result;
  }
  for (size_t index = newline + 1; index < connection->input.size(); ++index) {
    const char byte = connection->input[index];
    if (byte != ' ' && byte != '\t' && byte != '\r' && byte != '\n')
      return Throw(env, "multiple_requests", "only one request is permitted");
  }
  Set(env, result, "complete", Bool(env, true));
  Set(env, result, "frame", String(env, connection->input.substr(0, newline)));
  return result;
}

napi_value WriteFrame(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc != 2) {
    return Throw(env, "peer_write_failed", "handle and response required");
  }
  uint32_t connection_id = 0;
  std::string frame;
  if (napi_get_value_uint32(env, argv[0], &connection_id) != napi_ok ||
      !Utf8(env, argv[1], &frame) || frame.size() > 65535 ||
      frame.find('\n') != std::string::npos) {
    return Throw(env, "peer_write_failed", "invalid response frame");
  }
  Handle* connection = Find(connection_id, HandleKind::kConnection);
  if (!connection)
    return Throw(env, "peer_handle_invalid", "connection handle is not active");
  frame.push_back('\n');
  size_t offset = 0;
  while (offset < frame.size()) {
    const ssize_t written =
        send(connection->fd, frame.data() + offset, frame.size() - offset, 0);
    if (written > 0) {
      offset += static_cast<size_t>(written);
      continue;
    }
    if (written < 0 && errno == EINTR) continue;
    return Throw(env, "peer_write_failed", Errno("send"));
  }
  return Bool(env, true);
}

napi_value GetPeerSnapshot(napi_env env, napi_callback_info info) {
  uint32_t connection_id = 0;
  if (!OneUint32(env, info, &connection_id))
    return Throw(env, "peer_handle_invalid", "connection handle required");
  Handle* connection = Find(connection_id, HandleKind::kConnection);
  if (!connection)
    return Throw(env, "peer_handle_invalid", "connection handle is not active");
  return PeerObject(env, connection->initial_peer);
}

napi_value RevalidatePeer(napi_env env, napi_callback_info info) {
  uint32_t connection_id = 0;
  if (!OneUint32(env, info, &connection_id))
    return Throw(env, "peer_handle_invalid", "connection handle required");
  Handle* connection = Find(connection_id, HandleKind::kConnection);
  if (!connection)
    return Throw(env, "peer_handle_invalid", "connection handle is not active");
  PeerSnapshot current;
  std::string error;
  if (!ReadPeer(connection->fd, &current, &error) ||
      !SamePeer(current, connection->initial_peer)) {
    return Throw(env, "peer_authority_changed",
                 error.empty() ? "peer incarnation changed" : error);
  }
  return PeerObject(env, current);
}

napi_value InspectProcess(napi_env env, napi_callback_info info) {
  uint32_t pid = 0;
  if (!OneUint32(env, info, &pid) || pid == 0)
    return Throw(env, "peer_identity_unavailable", "positive pid required");
  ProcessSnapshot snapshot;
  std::string error;
  if (!ReadProcess(static_cast<pid_t>(pid), &snapshot, &error))
    return Throw(env, "peer_identity_unavailable", error);
  return ProcessObject(env, snapshot);
}

void CloseHandle(uint32_t id) {
  auto iterator = handles.find(id);
  if (iterator == handles.end()) return;
  Handle handle = std::move(iterator->second);
  handles.erase(iterator);
  close(handle.fd);
  if (handle.kind == HandleKind::kListener && !handle.path.empty()) {
    struct stat current = {};
    if (lstat(handle.path.c_str(), &current) == 0 &&
        S_ISSOCK(current.st_mode) && current.st_uid == geteuid() &&
        current.st_dev == handle.device && current.st_ino == handle.inode) {
      unlink(handle.path.c_str());
    }
  }
}

napi_value Close(napi_env env, napi_callback_info info) {
  uint32_t id = 0;
  if (!OneUint32(env, info, &id))
    return Throw(env, "peer_handle_invalid", "handle required");
  CloseHandle(id);
  return Bool(env, true);
}

void Cleanup(void*) {
  while (!handles.empty()) CloseHandle(handles.begin()->first);
}

#else

napi_value Unsupported(napi_env env, napi_callback_info) {
  return Throw(env, "peer_adapter_unavailable", "Darwin adapter required");
}

#endif

bool Export(napi_env env, napi_value exports, const char* name,
            napi_callback callback) {
  napi_value function;
  return napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr,
                              &function) == napi_ok &&
         napi_set_named_property(env, exports, name, function) == napi_ok;
}

napi_value Init(napi_env env, napi_value exports) {
  if (!Export(env, exports, "abiVersion", AbiVersion)) return nullptr;
#ifdef __APPLE__
  if (!Export(env, exports, "createListener", CreateListener) ||
      !Export(env, exports, "accept", Accept) ||
      !Export(env, exports, "readFrame", ReadFrame) ||
      !Export(env, exports, "writeFrame", WriteFrame) ||
      !Export(env, exports, "getPeerSnapshot", GetPeerSnapshot) ||
      !Export(env, exports, "revalidatePeer", RevalidatePeer) ||
      !Export(env, exports, "inspectProcess", InspectProcess) ||
      !Export(env, exports, "close", Close)) {
    return nullptr;
  }
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
#else
  if (!Export(env, exports, "createListener", Unsupported) ||
      !Export(env, exports, "accept", Unsupported) ||
      !Export(env, exports, "readFrame", Unsupported) ||
      !Export(env, exports, "writeFrame", Unsupported) ||
      !Export(env, exports, "getPeerSnapshot", Unsupported) ||
      !Export(env, exports, "revalidatePeer", Unsupported) ||
      !Export(env, exports, "inspectProcess", Unsupported) ||
      !Export(env, exports, "close", Unsupported)) {
    return nullptr;
  }
#endif
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
