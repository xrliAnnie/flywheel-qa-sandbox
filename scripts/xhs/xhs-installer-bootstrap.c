/* Root-invoked, never setuid. The independent installer pins this binary. */
#include "xhs-installation-verify.h"
static int bootstrap_close_fds(void){
    DIR *dir=opendir("/dev/fd");if(!dir)return -1;int own=dirfd(dir),fds[65536];size_t count=0;int bad=0;
    for(;;){errno=0;struct dirent *entry=readdir(dir);if(!entry){if(errno)bad=1;break;}if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
        char *end;errno=0;long fd=strtol(entry->d_name,&end,10);if(errno||*end||fd<0||fd>INT_MAX||count==65536){bad=1;break;}if(fd>2&&fd!=own)fds[count++]=(int)fd;}
    closedir(dir);for(size_t i=0;i<count;i++)if(close(fds[i])&&errno!=EBADF)bad=1;return bad?-1:0;
}
int main(int argc,char **argv){
    (void)argv;char failure[PATH_MAX]={0};
    if(argc!=1||getuid()!=0||geteuid()!=0)goto fail;
    if(xhs_verify_installation(failure))goto fail;
    umask(0077);if(chdir("/"))goto fail;
    int fd=open("/dev/null",O_RDONLY|O_NOFOLLOW);if(fd<0)goto fail;if(dup2(fd,0)<0){close(fd);goto fail;}if(fd>2)close(fd);
    if(bootstrap_close_fds())goto fail;
    char *environment[]={"PATH=/usr/bin:/bin","LANG=C","LC_ALL=C",NULL};
    char *arguments[]={INSTALLER_NODE,INSTALLER_ENTRY,NULL};
    execve(INSTALLER_NODE,arguments,environment);
fail:
    xhs_installation_error("xhs_installer_bootstrap_unavailable",failure);return 1;
}
