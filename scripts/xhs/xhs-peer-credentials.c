#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/ucred.h>
#endif
/* Only the already accepted socket is inherited as fd3. No paths or identity
 * claims are accepted through argv, stdin, environment or request headers. */
int main(int argc, char **argv) {
 (void)argv;
 if (argc != 1) return 1;
 struct sockaddr_storage address;
 socklen_t length=sizeof(address);
 memset(&address,0,sizeof(address));
 if(getsockname(3,(struct sockaddr *)&address,&length)!=0 || address.ss_family!=AF_UNIX) return 1;
 int type=0;length=sizeof(type);
 if(getsockopt(3,SOL_SOCKET,SO_TYPE,&type,&length)!=0 || type!=SOCK_STREAM) return 1;
 uid_t uid;
#ifdef __APPLE__
 struct xucred credentials;length=sizeof(credentials);
 memset(&credentials,0,sizeof(credentials));
 if(getsockopt(3,SOL_LOCAL,LOCAL_PEERCRED,&credentials,&length)!=0 || length<sizeof(credentials) || credentials.cr_version!=XUCRED_VERSION) return 1;
 uid=credentials.cr_uid;
#elif defined(__linux__)
 struct ucred credentials;length=sizeof(credentials);
 memset(&credentials,0,sizeof(credentials));
 if(getsockopt(3,SOL_SOCKET,SO_PEERCRED,&credentials,&length)!=0 || length<sizeof(credentials)) return 1;
 uid=credentials.uid;
#else
 return 1;
#endif
 return printf("%lu\n",(unsigned long)uid)>0?0:1;
}
