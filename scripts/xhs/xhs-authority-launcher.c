/* launchd owns/binds/chowns the two sockets before dropping to the dedicated
 * service UID. This launcher has no root privileges and grants no authority;
 * the Node startup loader still validates policy, principals and QA receipts. */
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include "xhs-installation-verify.h"
#ifdef __APPLE__
#include <launch.h>
#include <libproc.h>
#include <sys/proc_info.h>
#endif

static int listener_name(int fd, struct sockaddr_un *address) {
    int type = 0, accepting = 0;
    socklen_t size = sizeof(type), length = sizeof(*address);
    memset(address, 0, sizeof(*address));
    if (fd < 3 || getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) || type != SOCK_STREAM)
        return -1;
#ifdef __APPLE__
    /* Darwin returns ENOPROTOOPT for getsockopt(SO_ACCEPTCONN). Inspect the
     * current process's kernel socket options without changing listen state. */
    struct socket_fdinfo info;
    if (proc_pidfdinfo(getpid(), fd, PROC_PIDFDSOCKETINFO, &info, sizeof(info)) != sizeof(info)) return -1;
    accepting = (info.psi.soi_options & SO_ACCEPTCONN) != 0;
#else
    size = sizeof(accepting);
    if (getsockopt(fd, SOL_SOCKET, SO_ACCEPTCONN, &accepting, &size)) return -1;
#endif
    if (!accepting ||
        getsockname(fd, (struct sockaddr *)address, &length) ||
        address->sun_family != AF_UNIX || length <= offsetof(struct sockaddr_un, sun_path) ||
        !address->sun_path[0] || !memchr(address->sun_path, '\0', sizeof(address->sun_path)))
        return -1;
    return 0;
}

/* Duplicate both first: either source may already be fd3/fd4, in either order. */
static int xhs_adopt_listeners(int ingress, int authority) {
    struct sockaddr_un a, b;
    if (ingress == authority || listener_name(ingress, &a) || listener_name(authority, &b) ||
        !strcmp(a.sun_path, b.sun_path)) return -1;
    int public_copy = fcntl(ingress, F_DUPFD_CLOEXEC, 5);
    if (public_copy < 0) return -1;
    int private_copy = fcntl(authority, F_DUPFD_CLOEXEC, 5);
    if (private_copy < 0) { close(public_copy); return -1; }
    close(ingress); close(authority);
    int failed = dup2(public_copy, 3) < 0 || dup2(private_copy, 4) < 0;
    close(public_copy); close(private_copy);
    if (failed || fcntl(3, F_SETFD, 0) || fcntl(4, F_SETFD, 0)) return -1;
    return 0;
}

static int activate_one(const char *name) {
#ifdef __APPLE__
    int *fds = NULL;
    size_t count = 0;
    int status = launch_activate_socket(name, &fds, &count);
    if (status || count != 1 || !fds) {
        if (fds) { for (size_t i = 0; i < count; i++) close(fds[i]); free(fds); }
        return -1;
    }
    int fd = fds[0]; free(fds); return fd;
#else
    (void)name;
    errno = ENOTSUP;
    return -1;
#endif
}

int main(int argc, char **argv) {
    char failure[PATH_MAX]={0};
    if (argc == 4 && !strcmp(argv[1], "--verify-listeners")) {
        struct sockaddr_un ingress, authority;
        return listener_name(3, &ingress) || listener_name(4, &authority) ||
            !strcmp(ingress.sun_path, authority.sun_path) ||
            strcmp(ingress.sun_path, argv[2]) || strcmp(authority.sun_path, argv[3]) ? 1 : 0;
    }
    if (argc != 5 || argv[1][0] != '/' || argv[2][0] != '/' ||
        strcmp(argv[3], "--config") || argv[4][0] != '/' ||
        getuid() == 0 || getuid() != geteuid() || getgid() != getegid()) goto fail;
    if(strcmp(argv[1],INSTALLER_NODE)||strcmp(argv[2],AUTHORITY_ENTRY)||strcmp(argv[4],AUTHORITY_POLICY))goto fail;
    if(xhs_verify_installation(failure))goto fail;
    int ingress = activate_one("Ingress");
    if (ingress < 0) goto fail;
    int authority = activate_one("Authority");
    if (authority < 0 || xhs_adopt_listeners(ingress, authority)) goto fail;
    umask(0077);
    if (chdir("/")) goto fail;
    char *environment[] = { "PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", NULL };
    execve(argv[1], &argv[1], environment);
fail:
    xhs_installation_error("xhs_authority_launcher_unavailable",failure);
    return 1;
}
