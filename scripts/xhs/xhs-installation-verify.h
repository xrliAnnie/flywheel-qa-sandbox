#ifndef XHS_INSTALLATION_VERIFY_H
#define XHS_INSTALLATION_VERIFY_H
#include "xhs-native-tree.h"
#ifndef XHS_INSTALL_ROOT
#define XHS_INSTALL_ROOT "/Library/Application Support/Flywheel/Xhs"
#endif
#define BOOTSTRAP_POLICY XHS_INSTALL_ROOT "/installer-bootstrap.policy"
#define NATIVE_MANIFEST XHS_INSTALL_ROOT "/runtime.manifest"
#define JSON_MANIFEST XHS_INSTALL_ROOT "/runtime.manifest.json"
#define INSTALLATION_METADATA XHS_INSTALL_ROOT "/installation.metadata"
#define INSTALLER_NODE XHS_INSTALL_TREE "/node"
#define INSTALLER_ENTRY XHS_INSTALL_TREE "/installer-entry.js"
#define AUTHORITY_ENTRY XHS_INSTALL_TREE "/packages/teamlead/dist/xiaohongshu-write/authority-main.js"
#define AUTHORITY_POLICY XHS_INSTALL_ROOT "/authority.json"
typedef struct { char manifest_sha256[65]; char json_sha256[65]; } bootstrap_policy;
typedef struct { char manifest_sha256[65]; char bootstrap_sha256[65]; } installation_metadata;
static inline int bootstrap_digest(const char *raw,char *out){
    for(size_t i=0;i<64;i++)if(!((raw[i]>='0'&&raw[i]<='9')||(raw[i]>='a'&&raw[i]<='f')))return -1;
    memcpy(out,raw,64);out[64]=0;return 0;
}
static inline int parse_bootstrap_policy(const char *raw,size_t size,bootstrap_policy *out){
    const char first[]="version=1\nmanifest_sha256=", second[]="\njson_sha256=";
    size_t a=sizeof(first)-1,b=sizeof(second)-1;
    if(!raw||!out||size!=a+64+b+64+1||memcmp(raw,first,a)||memcmp(raw+a+64,second,b)||raw[size-1]!='\n')return -1;
    return bootstrap_digest(raw+a,out->manifest_sha256)||bootstrap_digest(raw+a+64+b,out->json_sha256)?-1:0;
}
static inline int parse_installation_metadata(const char *raw,size_t size,installation_metadata *out){
    const char first[]="version=1\nmanifest_sha256=",second[]="\nbootstrap_sha256=";size_t a=sizeof(first)-1,b=sizeof(second)-1;
    if(!raw||!out||size!=a+64+b+64+1||memcmp(raw,first,a)||memcmp(raw+a+64,second,b)||raw[size-1]!='\n')return -1;
    return bootstrap_digest(raw+a,out->manifest_sha256)||bootstrap_digest(raw+a+64+b,out->bootstrap_sha256)?-1:0;
}
static inline int bootstrap_ancestry(const char *path){
    char parent[PATH_MAX];if(strlen(path)>=sizeof(parent))return -1;strcpy(parent,path);
    for(;;){char *slash=strrchr(parent,'/');if(!slash)return -1;if(slash==parent)parent[1]=0;else *slash=0;
        struct stat s;if(lstat(parent,&s)||!S_ISDIR(s.st_mode)||!xhs_trusted_stat(&s))return -1;if(!strcmp(parent,"/"))return 0;}
}
static inline char *bootstrap_read(const char *path,size_t limit,const char *digest,size_t *size,struct stat *identity){
    struct stat before,after;if(bootstrap_ancestry(path)||lstat(path,&before)||!S_ISREG(before.st_mode)||!xhs_trusted_stat(&before)||before.st_gid!=0||before.st_nlink!=1||before.st_size<1||(uint64_t)before.st_size>limit)return NULL;
    int fd=open(path,O_RDONLY|O_NOFOLLOW|O_NONBLOCK);if(fd<0)return NULL;
    char *bytes=malloc((size_t)before.st_size+1);if(!bytes){close(fd);return NULL;}
    size_t used=0;int bad=fstat(fd,&after)||!xhs_same_stat(&before,&after);
    while(!bad&&used<=(size_t)before.st_size){ssize_t n=read(fd,bytes+used,(size_t)before.st_size+1-used);if(n<0){bad=1;break;}if(!n)break;used+=(size_t)n;}
    if(used!=(size_t)before.st_size||fstat(fd,&after)||!xhs_same_stat(&before,&after)||lstat(path,&after)||!xhs_same_stat(&before,&after))bad=1;
    close(fd);if(!bad&&digest&&xhs_hash_file(path,&before,digest))bad=1;
    if(bad){free(bytes);return NULL;}bytes[used]=0;*size=used;*identity=before;return bytes;
}

/* One fixed verifier shared by both native entrypoints, before any Node code. */
static inline int xhs_verify_installation(char failure[PATH_MAX]) {
    char *policy_bytes=NULL,*manifest_bytes=NULL,*json_bytes=NULL,*metadata_bytes=NULL;
    xhs_manifest manifest={0};bootstrap_policy policy;installation_metadata metadata;
    struct stat policy_stat,manifest_stat,json_stat,metadata_stat,now;size_t size;int bad=1;
    strcpy(failure,INSTALLATION_METADATA);
    metadata_bytes=bootstrap_read(INSTALLATION_METADATA,1024,NULL,&size,&metadata_stat);
    if(!metadata_bytes||parse_installation_metadata(metadata_bytes,size,&metadata))goto done;
    strcpy(failure,BOOTSTRAP_POLICY);
    policy_bytes=bootstrap_read(BOOTSTRAP_POLICY,1024,NULL,&size,&policy_stat);
    if(!policy_bytes||parse_bootstrap_policy(policy_bytes,size,&policy))goto done;
    if(strcmp(policy.manifest_sha256,metadata.manifest_sha256)){strcpy(failure,INSTALLATION_METADATA);goto done;}
    strcpy(failure,NATIVE_MANIFEST);
    manifest_bytes=bootstrap_read(NATIVE_MANIFEST,XHS_MANIFEST_BYTES,policy.manifest_sha256,&size,&manifest_stat);
    if(!manifest_bytes||xhs_parse_manifest(manifest_bytes,size,&manifest))goto done;
    strcpy(failure,JSON_MANIFEST);
    json_bytes=bootstrap_read(JSON_MANIFEST,XHS_MANIFEST_BYTES,policy.json_sha256,&size,&json_stat);
    if(!json_bytes)goto done;
    if(xhs_verify_native_tree(&manifest)){strcpy(failure,xhs_tree_failure_path);goto done;}
    const char *required[]={"node","installer-entry.js","xhs-installer-bootstrap","packages/teamlead/dist/xiaohongshu-write/authority-main.js"};
    for(size_t i=0;i<sizeof(required)/sizeof(required[0]);i++){
        size_t index=xhs_lower_bound(&manifest,required[i]);
        if(index==manifest.count||strcmp(manifest.entries[index].path,required[i])||((i==0||i==2)&&!(manifest.entries[index].mode&0111))){snprintf(failure,PATH_MAX,"%s/%s",XHS_INSTALL_TREE,required[i]);goto done;}
        if(i==2&&strcmp(manifest.entries[index].sha256,metadata.bootstrap_sha256)){strcpy(failure,INSTALLATION_METADATA);goto done;}
    }
    strcpy(failure,BOOTSTRAP_POLICY);if(lstat(BOOTSTRAP_POLICY,&now)||!xhs_same_stat(&policy_stat,&now))goto done;
    strcpy(failure,NATIVE_MANIFEST);if(lstat(NATIVE_MANIFEST,&now)||!xhs_same_stat(&manifest_stat,&now))goto done;
    strcpy(failure,JSON_MANIFEST);if(lstat(JSON_MANIFEST,&now)||!xhs_same_stat(&json_stat,&now))goto done;
    strcpy(failure,INSTALLATION_METADATA);if(lstat(INSTALLATION_METADATA,&now)||!xhs_same_stat(&metadata_stat,&now))goto done;
    failure[0]=0;bad=0;
done:
    free(policy_bytes);free(manifest_bytes);free(json_bytes);free(metadata_bytes);free(manifest.entries);return bad?-1:0;
}
/* Escape control bytes so one refusal always remains one diagnostic line. */
static inline void xhs_installation_error(const char *reason,const char *path){
    fputs(reason,stderr);if(path&&*path){fputs(": ",stderr);for(const unsigned char*p=(const unsigned char*)path;*p;p++){if(*p<32||*p>=127||*p=='\\')fprintf(stderr,"\\x%02x",*p);else fputc(*p,stderr);}}fputc('\n',stderr);
}
#endif
