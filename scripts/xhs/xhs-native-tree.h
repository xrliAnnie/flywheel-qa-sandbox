#ifndef XHS_NATIVE_TREE_H
#define XHS_NATIVE_TREE_H
#include "xhs-native-manifest.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <CommonCrypto/CommonDigest.h>
#endif
#ifndef XHS_INSTALL_TREE
#define XHS_INSTALL_TREE "/Library/Application Support/Flywheel/Xhs/runtime"
#endif
static inline int xhs_same_stat(const struct stat *a,const struct stat *b){
    if(a->st_dev!=b->st_dev||a->st_ino!=b->st_ino||a->st_mode!=b->st_mode||a->st_uid!=b->st_uid||a->st_gid!=b->st_gid||a->st_nlink!=b->st_nlink||a->st_size!=b->st_size)return 0;
#ifdef __APPLE__
    return a->st_mtimespec.tv_sec==b->st_mtimespec.tv_sec&&a->st_mtimespec.tv_nsec==b->st_mtimespec.tv_nsec&&a->st_ctimespec.tv_sec==b->st_ctimespec.tv_sec&&a->st_ctimespec.tv_nsec==b->st_ctimespec.tv_nsec;
#else
    return a->st_mtim.tv_sec==b->st_mtim.tv_sec&&a->st_mtim.tv_nsec==b->st_mtim.tv_nsec&&a->st_ctim.tv_sec==b->st_ctim.tv_sec&&a->st_ctim.tv_nsec==b->st_ctim.tv_nsec;
#endif
}
static inline int xhs_trusted_stat(const struct stat *s){return s->st_uid==0&&!(s->st_mode&07022);}
static inline size_t xhs_lower_bound(const xhs_manifest *m,const char *path){
    size_t lo=0,hi=m->count;while(lo<hi){size_t mid=lo+(hi-lo)/2;if(strcmp(m->entries[mid].path,path)<0)lo=mid+1;else hi=mid;}return lo;
}
static inline int xhs_hash_file(const char *path,const struct stat *before,const char *expected){
#ifdef __APPLE__
    int fd=open(path,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);if(fd<0)return -1;
    struct stat now;int bad=fstat(fd,&now)||!xhs_same_stat(before,&now);
    CC_SHA256_CTX hash;CC_SHA256_Init(&hash);unsigned char buffer[65536],digest[32];off_t total=0;
    while(!bad){ssize_t n=read(fd,buffer,sizeof(buffer));if(n<0){bad=1;break;}if(!n)break;total+=n;if(total>before->st_size){bad=1;break;}CC_SHA256_Update(&hash,buffer,(CC_LONG)n);}
    if(total!=before->st_size||fstat(fd,&now)||!xhs_same_stat(before,&now)||lstat(path,&now)||!xhs_same_stat(before,&now))bad=1;
    close(fd);CC_SHA256_Final(digest,&hash);char hex[65];for(int i=0;i<32;i++)snprintf(hex+2*i,3,"%02x",digest[i]);return bad||strcmp(hex,expected)?-1:0;
#else
    (void)path;(void)before;(void)expected;return -1;
#endif
}
static char xhs_tree_failure_path[PATH_MAX];
typedef struct { const xhs_manifest *manifest; struct stat *stats; unsigned char *seen; size_t files; size_t directories; uint64_t bytes; } xhs_tree_scan;
static inline int xhs_walk_tree(xhs_tree_scan *scan,const char *relative,unsigned int depth){
    snprintf(xhs_tree_failure_path,sizeof(xhs_tree_failure_path),"%s%s%s",XHS_INSTALL_TREE,*relative?"/":"",relative);
    if(depth>32)return -1;
    if(*relative && ++scan->directories+scan->files>XHS_MANIFEST_ENTRIES)return -1;
    char path[PATH_MAX];int length=snprintf(path,sizeof(path),"%s%s%s",XHS_INSTALL_TREE,*relative?"/":"",relative);if(length<0||(size_t)length>=sizeof(path))return -1;
    struct stat before,now;if(lstat(path,&before)||!S_ISDIR(before.st_mode)||!xhs_trusted_stat(&before)||before.st_gid!=0)return -1;
    if(*relative){char prefix[PATH_MAX];int n=snprintf(prefix,sizeof(prefix),"%s/",relative);if(n<0||(size_t)n>=sizeof(prefix))return -1;size_t i=xhs_lower_bound(scan->manifest,prefix);if(i==scan->manifest->count||strncmp(scan->manifest->entries[i].path,prefix,(size_t)n))return -1;}
    int fd=open(path,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);if(fd<0)return -1;
    if(fstat(fd,&now)||!xhs_same_stat(&before,&now)){close(fd);return -1;}
    DIR *directory=fdopendir(fd);if(!directory){close(fd);return -1;}
    int bad=0;
    while(!bad){errno=0;struct dirent *item=readdir(directory);if(!item){if(errno)bad=1;break;}if(!strcmp(item->d_name,".")||!strcmp(item->d_name,".."))continue;
        char child[PATH_MAX],absolute[PATH_MAX];int n=snprintf(child,sizeof(child),"%s%s%s",relative,*relative?"/":"",item->d_name);if(n<0||(size_t)n>=sizeof(child)){bad=1;break;}
        n=snprintf(absolute,sizeof(absolute),"%s/%s",XHS_INSTALL_TREE,child);if(n<0||(size_t)n>=sizeof(absolute)){bad=1;break;}strcpy(xhs_tree_failure_path,absolute);if(xhs_relative_path(child,strlen(child))||lstat(absolute,&now)||!xhs_trusted_stat(&now)||now.st_gid!=0){bad=1;break;}
        if(S_ISDIR(now.st_mode)){bad=xhs_walk_tree(scan,child,depth+1)!=0;continue;}
        size_t index=xhs_lower_bound(scan->manifest,child);if(index==scan->manifest->count||strcmp(scan->manifest->entries[index].path,child)||scan->seen[index]||!S_ISREG(now.st_mode)||now.st_nlink!=1||now.st_size<0||now.st_size>256*1024*1024||(now.st_mode&07777)!=scan->manifest->entries[index].mode){bad=1;break;}
        scan->bytes+=(uint64_t)now.st_size;if(scan->bytes>UINT64_C(2147483648)||xhs_hash_file(absolute,&now,scan->manifest->entries[index].sha256)){bad=1;break;}
        scan->stats[index]=now;scan->seen[index]=1;scan->files++;if(scan->files+scan->directories>XHS_MANIFEST_ENTRIES){bad=1;break;}
    }
    if(fstat(fd,&now)||!xhs_same_stat(&before,&now)||lstat(path,&now)||!xhs_same_stat(&before,&now)){if(!bad)strcpy(xhs_tree_failure_path,path);bad=1;}
    closedir(directory);return bad?-1:0;
}
/* Only the fixed installed tree. Caller must authenticate the manifest and
 * bootstrap's own bytes from immutable root policy before invoking this. */
static inline int xhs_verify_native_tree(const xhs_manifest *manifest){
    snprintf(xhs_tree_failure_path,sizeof(xhs_tree_failure_path),"%s",XHS_INSTALL_TREE);
    if(!manifest||!manifest->entries||!manifest->count||manifest->count>XHS_MANIFEST_ENTRIES)return -1;
    char parent[PATH_MAX];if(strlen(XHS_INSTALL_TREE)>=sizeof(parent))return -1;strcpy(parent,XHS_INSTALL_TREE);
    for(;;){strcpy(xhs_tree_failure_path,parent);struct stat s;if(lstat(parent,&s)||!S_ISDIR(s.st_mode)||!xhs_trusted_stat(&s))return -1;if(!strcmp(parent,"/"))break;char *slash=strrchr(parent,'/');if(!slash)return -1;if(slash==parent)parent[1]=0;else *slash=0;}
    xhs_tree_scan scan={manifest,calloc(manifest->count,sizeof(struct stat)),calloc(manifest->count,1),0,0,0};if(!scan.stats||!scan.seen){free(scan.stats);free(scan.seen);return -1;}
    int bad=xhs_walk_tree(&scan,"",0)!=0;
    for(size_t i=0;!bad&&i<manifest->count;i++){char path[PATH_MAX];int n=snprintf(path,sizeof(path),"%s/%s",XHS_INSTALL_TREE,manifest->entries[i].path);struct stat now;if(n<0||(size_t)n>=sizeof(path)||!scan.seen[i]||lstat(path,&now)||!xhs_same_stat(&scan.stats[i],&now)){snprintf(xhs_tree_failure_path,sizeof(xhs_tree_failure_path),"%s",path);bad=1;}}
    free(scan.stats);free(scan.seen);return bad?-1:0;
}
#endif
