#include <stdio.h>
#include <string.h>

static int secret_sum(int a, int b) {
  return a + b;
}

int vulnerable_copy(char *dst, const char *src) {
  /* intentional simple helper for static analysis, not a real vuln claim */
  strcpy(dst, src);
  return (int)strlen(dst);
}

int main(int argc, char **argv) {
  char buf[64];
  int n = secret_sum(argc, 40);
  if (argc > 1) {
    n += vulnerable_copy(buf, argv[1]);
    printf("hello deepsonar-reverse sample: %s (%d)\n", buf, n);
  } else {
    printf("hello deepsonar-reverse sample (%d)\n", n);
  }
  return 0;
}
