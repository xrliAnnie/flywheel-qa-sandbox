// Test-only native syscall probe. Apply the generated policy before accessing
// synthetic xattrs; never open the probed paths for file data.
#include <errno.h>
#include <sandbox.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/xattr.h>

int main(int argc, char **argv) {
  if (argc != 7) return 2;
  FILE *input = fopen(argv[1], "rb");
  if (!input) return 3;
  char policy[131073];
  size_t length = fread(policy, 1, sizeof(policy) - 1, input);
  int extra = fgetc(input);
  fclose(input);
  if (extra != EOF || !length) return 4;
  policy[length] = 0;
  char *error = NULL;
  if (sandbox_init(policy, 0, &error) != 0) {
    fprintf(stderr, "sandbox_init_failed: %s\n", error ? error : "unknown");
    if (error) sandbox_free_error(error);
    return 5;
  }
  int allowed[2] = {0, 0};
  char value[256];
  for (int i = 0; i < 2; ++i) {
    ssize_t size = getxattr(argv[2 + i], argv[5], value, sizeof(value), 0, 0);
    allowed[i] = size == (ssize_t)strlen(argv[6]) &&
                 memcmp(value, argv[6], (size_t)(size < 0 ? 0 : size)) == 0;
  }
  errno = 0;
  ssize_t deniedSize = getxattr(argv[4], argv[5], value, sizeof(value), 0, 0);
  int denied = deniedSize < 0 && (errno == EPERM || errno == EACCES);
  printf("{\"directoryXattrReadable\":%s,\"childXattrReadable\":%s,\"outsideXattrDenied\":%s}\n",
         allowed[0] ? "true" : "false", allowed[1] ? "true" : "false", denied ? "true" : "false");
  return allowed[0] && allowed[1] && denied ? 0 : 6;
}
