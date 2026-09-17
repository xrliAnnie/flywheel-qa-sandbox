/* Root-invoked, never setuid. Executes only the fixed synthetic probe interface
 * after dropping all root credentials. The trusted installer pins these bytes,
 * Node, probe entry and their complete dependency closure before invoking it. */
#include <errno.h>
#include <dirent.h>
#ifdef __APPLE__
#include <CommonCrypto/CommonDigest.h>
#endif
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <pwd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define INSTALL_ROOT "/Library/Application Support/Flywheel/Xhs/"
#define FIXTURE_ROOT "/private/var/db/flywheel-xhs-qa/"
#define GROUP_LIMIT 128

static int positive_id(const char *value, unsigned int *result) {
    if (!value || !*value || strlen(value) > 10) return -1;
    unsigned long n = 0;
    for (const char *p = value; *p; ++p) {
        if (*p < '0' || *p > '9') return -1;
        n = n * 10 + (unsigned)(*p - '0');
        if (n > INT_MAX) return -1;
    }
    if (!n || value[0] == '0') return -1;
    *result = (unsigned int)n;
    return 0;
}
static int canonical_path(const char *path) {
    if (!path || path[0] != '/' || strlen(path) >= PATH_MAX ||
        path[strlen(path)-1] == '/' || strstr(path,"//")) return -1;
    const char *part = path + 1;
    for (;;) {
        const char *slash = strchr(part,'/');
        size_t n = slash ? (size_t)(slash-part) : strlen(part);
        if ((n == 1 && part[0] == '.') || (n == 2 && !memcmp(part,"..",2))) return -1;
        for (size_t i = 0; i < n; ++i) if ((unsigned char)part[i] < 32) return -1;
        if (!slash) break;
        part = slash + 1;
    }
    return 0;
}
static int fixed_fixture(const char *path) {
    size_t prefix = strlen(FIXTURE_ROOT);
    if (strlen(path) != prefix + 64 || strncmp(path,FIXTURE_ROOT,prefix)) return -1;
    for (const char *p = path + prefix; *p; ++p)
        if (!(*p >= '0' && *p <= '9') && !(*p >= 'a' && *p <= 'f')) return -1;
    return 0;
}
/* lstat every ancestor: no service/model writable directory or symlink.
 * The root installer independently checks SHA256; this is not a digest receipt. */
static int immutable_path(const char *path, int directory, int executable) {
    if (canonical_path(path)) return -1;
    struct stat leaf, opened;
    if (lstat(path,&leaf) || leaf.st_uid != 0 || (leaf.st_mode & 022) ||
        (directory ? !S_ISDIR(leaf.st_mode) : (!S_ISREG(leaf.st_mode) || leaf.st_nlink != 1)) ||
        (!directory && (leaf.st_size < 1 || leaf.st_size > 256 * 1024 * 1024)) ||
        (executable && !(leaf.st_mode & 0111))) return -1;
    char parent[PATH_MAX];
    memcpy(parent,path,strlen(path)+1);
    for (;;) {
        char *slash = strrchr(parent,'/');
        if (!slash) return -1;
        if (slash == parent) parent[1] = 0; else *slash = 0;
        struct stat s;
        if (lstat(parent,&s) || !S_ISDIR(s.st_mode) || s.st_uid != 0 || (s.st_mode & 022)) return -1;
        if (parent[1] == 0) break;
    }
    int fd = open(path,O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) return -1;
    int bad = fstat(fd,&opened) || opened.st_dev != leaf.st_dev || opened.st_ino != leaf.st_ino ||
        opened.st_mode != leaf.st_mode || opened.st_uid != leaf.st_uid;
    close(fd);
    return bad ? -1 : 0;
}
static int allowed_probe(const char *role, const char *probe) {
    if (!strcmp(role,"service"))
        return strcmp(probe,"file-control") && strcmp(probe,"authority-flow") ? -1 : 0;
    if (!strcmp(role,"model")) return strcmp(probe,"file-authority") ? -1 : 0;
    return -1;
}

#define POLICY_PATH INSTALL_ROOT "fixture-runner.policy"
typedef struct {
    unsigned int service_uid, service_gid, model_uid, model_gid;
    char node[PATH_MAX], entry[PATH_MAX], fixture[PATH_MAX];
    char node_sha[65], entry_sha[65];
} runner_policy;
static int line(FILE *input, const char *prefix, char *out, size_t capacity) {
    char buffer[PATH_MAX + 80];
    if (!fgets(buffer,sizeof(buffer),input)) return -1;
    size_t n = strlen(buffer), p = strlen(prefix);
    if (!n || buffer[n-1] != '\n' || n <= p + 1 || strncmp(buffer,prefix,p)) return -1;
    buffer[--n] = 0;
    if (strchr(buffer,'\r') || n - p >= capacity) return -1;
    memcpy(out,buffer+p,n-p+1);
    return 0;
}
static int read_id(FILE *input, const char *prefix, unsigned int *value) {
    char raw[12];
    return line(input,prefix,raw,sizeof(raw)) || positive_id(raw,value) ? -1 : 0;
}
static int digest_text(const char *s) {
    if (strlen(s) != 64) return -1;
    for (; *s; ++s) if (!(*s >= 'a' && *s <= 'f') && !(*s >= '0' && *s <= '9')) return -1;
    return 0;
}
static int parse_policy(FILE *input, runner_policy *p) {
    char version[8];
    if (line(input,"version=",version,sizeof(version)) || strcmp(version,"1") ||
        read_id(input,"service_uid=",&p->service_uid) || read_id(input,"service_gid=",&p->service_gid) ||
        read_id(input,"model_uid=",&p->model_uid) || read_id(input,"model_gid=",&p->model_gid) ||
        line(input,"node=",p->node,sizeof(p->node)) || line(input,"node_sha256=",p->node_sha,sizeof(p->node_sha)) ||
        line(input,"entry=",p->entry,sizeof(p->entry)) || line(input,"entry_sha256=",p->entry_sha,sizeof(p->entry_sha)) ||
        line(input,"fixture=",p->fixture,sizeof(p->fixture)) || fgetc(input) != EOF || ferror(input) ||
        p->service_uid == p->model_uid || p->service_gid == 80 ||
        strncmp(p->node,INSTALL_ROOT,strlen(INSTALL_ROOT)) || strncmp(p->entry,INSTALL_ROOT,strlen(INSTALL_ROOT)) ||
        canonical_path(p->node) || canonical_path(p->entry) || fixed_fixture(p->fixture) ||
        digest_text(p->node_sha) || digest_text(p->entry_sha)) return -1;
    return 0;
}
static int measured_binary(const char *path, const char *expected, int executable) {
#ifdef __APPLE__
    if (immutable_path(path,0,executable)) return -1;
    int fd = open(path,O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) return -1;
    struct stat before, after, named;
    if (fstat(fd,&before)) { close(fd); return -1; }
    CC_SHA256_CTX context;
    unsigned char bytes[65536], digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Init(&context);
    ssize_t n;
    off_t total = 0;
    while ((n = read(fd,bytes,sizeof(bytes))) > 0) {
        total += n;
        if (total > 256 * 1024 * 1024) { close(fd); return -1; }
        CC_SHA256_Update(&context,bytes,(CC_LONG)n);
    }
    int bad = n < 0 || total != before.st_size || fstat(fd,&after) || lstat(path,&named) ||
        before.st_dev != after.st_dev || before.st_ino != after.st_ino || before.st_size != after.st_size ||
        before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
        before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
        before.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec ||
        before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec ||
        named.st_dev != before.st_dev || named.st_ino != before.st_ino;
    close(fd);
    CC_SHA256_Final(digest,&context);
    char hex[65];
    for (int i = 0; i < 32; ++i) snprintf(hex+i*2,3,"%02x",digest[i]);
    return bad || strcmp(hex,expected) || immutable_path(path,0,executable) ? -1 : 0;
#else
    (void)path; (void)expected; (void)executable;
    return -1; /* The guarded installation target is macOS. */
#endif
}
static int close_inherited(void) {
    DIR *directory = opendir("/dev/fd");
    if (!directory) return -1;
    int own = dirfd(directory), fds[65536];
    size_t count = 0;
    struct dirent *entry;
    errno = 0;
    while ((entry = readdir(directory))) {
        if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..") ||
            !strcmp(entry->d_name,"0") || !strcmp(entry->d_name,"1") || !strcmp(entry->d_name,"2")) continue;
        unsigned int fd;
        if (positive_id(entry->d_name,&fd) || count == 65536) { closedir(directory); return -1; }
        if ((int)fd != own) fds[count++] = (int)fd;
    }
    int bad = errno != 0;
    closedir(directory);
    for (size_t i = 0; i < count; ++i) if (close(fds[i]) && errno != EBADF) bad = 1;
    return bad ? -1 : 0;
}
int main(int argc, char **argv) {
    if (getuid() != 0 || geteuid() != 0 || argc != 3 || allowed_probe(argv[1],argv[2])) goto fail;
    if (immutable_path(POLICY_PATH,0,0)) goto fail;
    int policy_fd = open(POLICY_PATH,O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (policy_fd < 0) goto fail;
    FILE *input = fdopen(policy_fd,"r");
    if (!input) { close(policy_fd); goto fail; }
    runner_policy policy;
    int invalid = parse_policy(input,&policy);
    fclose(input);
    if (invalid || measured_binary(policy.node,policy.node_sha,1) ||
        measured_binary(policy.entry,policy.entry_sha,0) || immutable_path(policy.fixture,1,0)) goto fail;
    int service = !strcmp(argv[1],"service");
    unsigned int uid = service ? policy.service_uid : policy.model_uid;
    unsigned int gid = service ? policy.service_gid : policy.model_gid;
    struct passwd *pw = getpwuid((uid_t)uid);
    if (!pw || pw->pw_uid != uid || pw->pw_gid != gid) goto fail;
    if (service && (strcmp(pw->pw_name,"_flywheel_xhs") ||
        (strcmp(pw->pw_shell,"/usr/bin/false") && strcmp(pw->pw_shell,"/bin/false") &&
         strcmp(pw->pw_shell,"/usr/sbin/nologin")))) goto fail;
    int count = GROUP_LIMIT;
#ifdef __APPLE__
    int raw[GROUP_LIMIT];
#else
    gid_t raw[GROUP_LIMIT];
#endif
    if (getgrouplist(pw->pw_name,pw->pw_gid,raw,&count) < 0 || count < 1 || count > GROUP_LIMIT) goto fail;
    gid_t groups[GROUP_LIMIT];
    for (int i = 0; i < count; ++i) {
#ifdef __APPLE__
        if (raw[i] < 0) goto fail;
#endif
        groups[i] = (gid_t)raw[i];
        if (service && groups[i] != (gid_t)gid) goto fail;
    }
    if (setgroups(count,groups) || setgid((gid_t)gid) || setuid((uid_t)uid) ||
        getuid() != uid || geteuid() != uid || getgid() != gid || getegid() != gid) goto fail;
    gid_t actual[GROUP_LIMIT];
    if (getgroups(GROUP_LIMIT,actual) != count) goto fail;
    for (int i = 0; i < count; ++i) {
        int found = 0;
        for (int j = 0; j < count; ++j) if (actual[i] == groups[j]) found = 1;
        if (!found) goto fail;
    }
    umask(0077);
    if (chdir("/")) goto fail;
    int nullfd = open("/dev/null",O_RDONLY | O_NOFOLLOW);
    if (nullfd < 0 || dup2(nullfd,0) < 0) goto fail;
    if (nullfd > 2) close(nullfd);
    if (close_inherited()) goto fail;
    char *environment[] = {"PATH=/usr/bin:/bin","LANG=C","LC_ALL=C",NULL};
    char *arguments[] = {policy.node,policy.entry,"--probe",argv[2],"--fixture",policy.fixture,NULL};
    execve(policy.node,arguments,environment);
fail:
    fputs("xhs_fixture_principal_unavailable\n",stderr);
    return 1;
}
