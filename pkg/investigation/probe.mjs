import { UnixFS } from 'ipfs-unixfs'
import { LongBits } from '../node_modules/.pnpm/protons-runtime@8.0.1/node_modules/protons-runtime/dist/src/utils/longbits.js'
import { createWriter } from '../node_modules/.pnpm/protons-runtime@8.0.1/node_modules/protons-runtime/dist/src/utils/writer.js'
import * as pb from '@ipld/dag-pb'
import { readFileSync, writeFileSync } from 'node:fs'
export const hex = b => Buffer.from(b).toString('hex')
export function varint(n) { const a=[]; do { let b=Number(n&127n); n >>= 7n; a.push(b | (n ? 128 : 0)) } while(n); return a }
export function decode(b) {
 let p=0; const fields=[];
 function v() { let n=0n; for(let s=0n;s<70n;s+=7n) {if(p>=b.length) throw Error('truncated');const c=b[p++];n|=BigInt(c&127)<<s;if(!(c&128)) return n} throw Error('overflow') }
 while(p<b.length) {const at=p, tag=Number(v()), field=tag>>>3, wire=tag&7;if(!field) throw Error(`field zero at ${at}; prior=${JSON.stringify(fields)}`);let value;if(wire===0)value=String(v());else if(wire===2){const len=Number(v());if(p+len>b.length)throw Error('truncated bytes');value=hex(b.subarray(p,p+len));p+=len}else throw Error(`wire ${wire} at ${at}; prior=${JSON.stringify(fields)}`);fields.push([field,value])}return fields
}
if (process.argv[1].endsWith('/probe.mjs')) {
 for(const n of [0n,2147483647n,2147483648n,2147483776n,3891799298n,4294967295n,4294967296n,6442450944n,9007199254740991n,9223372036854775808n,18446744073709551615n]) {
 const actual=new UnixFS({type:'file',blockSizes:[n]}).marshal(); const expected=Uint8Array.from([8,2,24,...varint(n),32,...varint(n)]);
 console.log(String(n),hex(actual)===hex(expected)?'OK':'BAD','actual='+hex(actual),'expected='+hex(expected));
 }
 try {new UnixFS({type:'file',blockSizes:[2147483648]}).marshal()}catch(e){console.log('number input:',e.toString())}
 console.log('bits:',LongBits.fromNumber(2147483648),'length:',LongBits.fromNumber(2147483648).length());
 const original=Buffer.allocUnsafe;
 for(const fill of [0,0xa5,0x5a]) {Buffer.allocUnsafe=n=>original(n).fill(fill);const b=new UnixFS({type:'file',blockSizes:[2147483648n]}).marshal();Buffer.allocUnsafe=original; console.log('allocation fill',fill,hex(b));try{console.log('independent decode',decode(b))}catch(e){console.log('independent decode:',e.message)}writeFileSync(`investigation/fill-${fill}.pb`,pb.encode({Data:b,Links:[]}))}
 // Fill the actual shared allocation pool, without replacing allocUnsafe.
 const slab=Buffer.allocUnsafe(1);new Uint8Array(slab.buffer,slab.byteOffset+1).fill(0x6b);
 const pooled=new UnixFS({type:'file',blockSizes:[2147483648n]}).marshal();console.log('pool same backing store',pooled.buffer===slab.buffer,'pool output',hex(pooled));
 for(let i=0;i<3;i++)console.log('natural',hex(new UnixFS({type:'file',blockSizes:[2147483648n]}).marshal()));
 console.log('uint64Number',hex(createWriter().uint64Number(2147483648).finish()));
 const root=readFileSync('../work/dbg/root.bin');const node=pb.decode(root);console.log('original root',root.length,'links',node.Links.length,'Data',hex(node.Data));try{console.log(decode(node.Data))}catch(e){console.log('original independent decode:',e.message)}
 writeFileSync('investigation/good.pb',pb.encode({Data:Uint8Array.from([8,2,24,...varint(2147483648n),32,...varint(2147483648n)]),Links:[]}));
}
