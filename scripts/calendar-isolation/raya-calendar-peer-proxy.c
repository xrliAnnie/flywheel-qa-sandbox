#define _GNU_SOURCE

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#ifdef __APPLE__
#include <sys/ucred.h>
#endif

static volatile sig_atomic_t stopping = 0;
static int listener_fd = -1;
static const char *bound_socket_path = NULL;

static void stop_proxy(int signal_number) {
	(void)signal_number;
	stopping = 1;
	if (listener_fd >= 0) {
		close(listener_fd);
		listener_fd = -1;
	}
}

static void cleanup_socket(void) {
	if (bound_socket_path != NULL) {
		unlink(bound_socket_path);
	}
}

static int parse_uid(const char *value, uid_t *result) {
	char *end = NULL;
	errno = 0;
	unsigned long parsed = strtoul(value, &end, 10);
	if (errno != 0 || end == value || *end != '\0' || (uid_t)parsed != parsed) {
		return -1;
	}
	*result = (uid_t)parsed;
	return 0;
}

static int peer_uid(int fd, uid_t *result) {
#ifdef __APPLE__
	struct xucred credentials;
	socklen_t length = sizeof(credentials);
	memset(&credentials, 0, sizeof(credentials));
	if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &credentials, &length) != 0) {
		return -1;
	}
	if (length < sizeof(credentials) || credentials.cr_version != XUCRED_VERSION) {
		errno = EPROTO;
		return -1;
	}
	*result = credentials.cr_uid;
	return 0;
#elif defined(__linux__)
	struct ucred credentials;
	socklen_t length = sizeof(credentials);
	memset(&credentials, 0, sizeof(credentials));
	if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0) {
		return -1;
	}
	if (length < sizeof(credentials)) {
		errno = EPROTO;
		return -1;
	}
	*result = credentials.uid;
	return 0;
#else
	(void)fd;
	(void)result;
	errno = ENOTSUP;
	return -1;
#endif
}

static int remove_stale_socket(const char *path) {
	struct stat existing;
	if (lstat(path, &existing) != 0) {
		return errno == ENOENT ? 0 : -1;
	}
	if (!S_ISSOCK(existing.st_mode)) {
		errno = EEXIST;
		return -1;
	}
	return unlink(path);
}

static int run_handler(int client_fd, char *const handler_argv[]) {
	pid_t child = fork();
	if (child < 0) {
		return -1;
	}
	if (child == 0) {
		if (dup2(client_fd, STDIN_FILENO) < 0 ||
			dup2(client_fd, STDOUT_FILENO) < 0) {
			_exit(126);
		}
		close(client_fd);
		if (listener_fd >= 0) close(listener_fd);
		execvp(handler_argv[0], handler_argv);
		dprintf(STDOUT_FILENO,
			"{\"ok\":false,\"error\":\"writer handler unavailable\"}\n");
		_exit(127);
	}
	close(client_fd);
	int status = 0;
	while (waitpid(child, &status, 0) < 0) {
		if (errno != EINTR) return -1;
	}
	return 0;
}

int main(int argc, char *argv[]) {
	if (argc < 4) {
		fprintf(stderr,
			"usage: raya-calendar-peer-proxy <socket> <ingress-uid> <handler> [args...]\n");
		return 64;
	}
	const char *socket_path = argv[1];
	uid_t expected_uid = 0;
	if (parse_uid(argv[2], &expected_uid) != 0) {
		fprintf(stderr, "invalid ingress uid\n");
		return 64;
	}
	if (strlen(socket_path) == 0 || strlen(socket_path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) {
		fprintf(stderr, "socket path is invalid\n");
		return 64;
	}
	if (remove_stale_socket(socket_path) != 0) {
		perror("refusing socket path");
		return 73;
	}

	struct sigaction action;
	memset(&action, 0, sizeof(action));
	action.sa_handler = stop_proxy;
	sigemptyset(&action.sa_mask);
	if (sigaction(SIGINT, &action, NULL) != 0 ||
		sigaction(SIGTERM, &action, NULL) != 0) {
		perror("sigaction");
		return 71;
	}

	listener_fd = socket(AF_UNIX, SOCK_STREAM, 0);
	if (listener_fd < 0) {
		perror("socket");
		return 71;
	}
	struct sockaddr_un address;
	memset(&address, 0, sizeof(address));
	address.sun_family = AF_UNIX;
	memcpy(address.sun_path, socket_path, strlen(socket_path) + 1);
#ifdef __APPLE__
	address.sun_len = SUN_LEN(&address);
#endif
	if (bind(listener_fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
		perror("bind");
		close(listener_fd);
		return 73;
	}
	bound_socket_path = socket_path;
	if (atexit(cleanup_socket) != 0 || chmod(socket_path, 0660) != 0) {
		perror("socket permissions");
		close(listener_fd);
		return 73;
	}
	if (listen(listener_fd, 16) != 0) {
		perror("listen");
		close(listener_fd);
		return 71;
	}

	while (!stopping) {
		int client_fd = accept(listener_fd, NULL, NULL);
		if (client_fd < 0) {
			if (stopping || errno == EINTR || errno == EBADF) continue;
			perror("accept");
			return 71;
		}
		uid_t actual_uid = 0;
		if (peer_uid(client_fd, &actual_uid) != 0) {
			dprintf(client_fd,
				"{\"ok\":false,\"error\":\"peer credential unavailable\"}\n");
			close(client_fd);
			continue;
		}
		if (actual_uid != expected_uid) {
			dprintf(client_fd,
				"{\"ok\":false,\"error\":\"unauthorized peer\"}\n");
			close(client_fd);
			continue;
		}
		if (run_handler(client_fd, &argv[3]) != 0) {
			perror("writer handler");
			return 71;
		}
	}
	return 0;
}
