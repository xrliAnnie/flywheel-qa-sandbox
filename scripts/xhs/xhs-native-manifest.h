#ifndef XHS_NATIVE_MANIFEST_H
#define XHS_NATIVE_MANIFEST_H
/* Fixed installed-tree inventory only. Root-policy authentication and actual
 * file/ancestry/hash checks must precede execution; parsing grants no authority. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#define XHS_MANIFEST_BYTES (4u * 1024u * 1024u)
#define XHS_MANIFEST_ENTRIES 20000u
#define XHS_MANIFEST_PATH 1024u

typedef struct { char sha256[65]; mode_t mode; char path[XHS_MANIFEST_PATH]; } xhs_manifest_entry;
typedef struct { xhs_manifest_entry *entries; size_t count; } xhs_manifest;

static inline int xhs_relative_path(const char *path, size_t n) {
    if (!n || n >= XHS_MANIFEST_PATH || path[0]=='/' || path[0]==' ' || path[n-1]==' ' || path[n-1]=='/') return -1;
    size_t part=0, depth=1;
    for (size_t i=0;i<=n;i++) {
        if (i<n) {
            unsigned char c=(unsigned char)path[i];
            if (c<32 || c>126 || (c==' ' && i && path[i-1]==' ')) return -1;
        }
        if (i==n || path[i]=='/') {
            size_t length=i-part;
            if (!length || (length==1 && path[part]=='.') || (length==2 && path[part]=='.' && path[part+1]=='.') || path[part]==' ' || path[i-1]==' ') return -1;
            part=i+1;
            if(i<n && ++depth>32) return -1;
        }
    }
    return 0;
}
static inline int xhs_parse_manifest(const char *raw, size_t size, xhs_manifest *out) {
    if (!out || out->entries || out->count || !raw || !size || size>XHS_MANIFEST_BYTES || raw[size-1]!='\n') return -1;
    xhs_manifest_entry *entries=calloc(XHS_MANIFEST_ENTRIES,sizeof(*entries));
    if(!entries)return -1;
    size_t offset=0,count=0;
    while(offset<size) {
        const char *end=memchr(raw+offset,'\n',size-offset);
        if(!end || count==XHS_MANIFEST_ENTRIES)goto fail;
        const char *line=raw+offset;
        size_t n=(size_t)(end-line);
        if(n<75 || n>=74+XHS_MANIFEST_PATH || line[64]!=' ' || line[69]!=' ' || memcmp(line+70,"0:0 ",4))goto fail;
        for(size_t i=0;i<64;i++) if(!((line[i]>='0'&&line[i]<='9')||(line[i]>='a'&&line[i]<='f')))goto fail;
        unsigned int mode=0;
        for(size_t i=65;i<69;i++){if(line[i]<'0'||line[i]>'7')goto fail; mode=mode*8+(unsigned int)(line[i]-'0');}
        if(mode&07022u || xhs_relative_path(line+74,n-74))goto fail;
        memcpy(entries[count].sha256,line,64);
        entries[count].mode=(mode_t)mode;
        memcpy(entries[count].path,line+74,n-74);
        if(count && strcmp(entries[count-1].path,entries[count].path)>=0)goto fail;
        count++; offset+=n+1;
    }
    out->entries=entries;out->count=count;return 0;
fail:
    free(entries);return -1;
}
#endif
