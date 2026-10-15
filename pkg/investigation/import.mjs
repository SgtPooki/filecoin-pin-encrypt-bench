import { importer } from 'ipfs-unixfs-importer'
import { balanced } from 'ipfs-unixfs-importer/layout'
import * as pb from '@ipld/dag-pb'
import { writeFileSync } from 'node:fs'
import { hex, decode } from './probe.mjs'
for (const [name,size,extra] of [['1025MiB',1025*1048576,{}],['3891799298',3891799298,{}],['2049MiB-subtree',2049*1048576,{layout:balanced({maxChildrenPerNode:2048})}]]) {
 const blocks=new Map();let puts=0, bad=0;const failures=[];
 const store={async put(cid,b){puts++;if(cid.code===pb.code){try{decode(pb.decode(b).Data)}catch(e){bad++;failures.push([cid.toString(),e.message])}}if(!blocks.has(cid.toString()))blocks.set(cid.toString(),b.slice());return cid}};
 async function* zeros(){const chunk=new Uint8Array(1048576);for(let remaining=size;remaining>0;remaining-=chunk.length)yield chunk.subarray(0,Math.min(remaining,chunk.length))}
 let result;for await(const item of importer([{path:name,content:zeros()}],store,{profile:'unixfs-v1-2025',...extra}))result=item;
 const root=blocks.get(result.cid.toString());writeFileSync(`investigation/${name}.pb`,root);
 console.log(JSON.stringify({name,inputBytes:size,puts,uniqueBlocks:blocks.size,bad,failures,cid:result.cid.toString(),fileSize:String(result.unixfs.fileSize()),blockSizes:result.unixfs.blockSizes.map(String),rootData:hex(pb.decode(root).Data)}));
 // Save all unique blocks for Kubo validation (zero leaves deduplicate).
 for(const [cid,b] of blocks)writeFileSync(`investigation/block-${cid}`,b);
}
