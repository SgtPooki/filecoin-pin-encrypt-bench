import { createWriter } from '../node_modules/.pnpm/protons-runtime@8.0.1/node_modules/protons-runtime/dist/src/utils/writer.js'
import { LongBits } from '../node_modules/.pnpm/protons-runtime@8.0.1/node_modules/protons-runtime/dist/src/utils/longbits.js'
import { UnixFS } from 'ipfs-unixfs'
import {varint,hex} from './probe.mjs'
let seed=1n;const values=[0n,1n,(1n<<31n)-1n,1n<<31n,(1n<<32n)-1n,1n<<32n,(1n<<64n)-1n];
for(let i=0;i<10000;i++){seed=(seed*6364136223846793005n+1n)&((1n<<64n)-1n);values.push(seed,seed&0xffffffffn)}
const original=Buffer.allocUnsafe;Buffer.allocUnsafe=n=>original(n).fill(0);
let bad=0,outside=0;for(const n of values){if(hex(createWriter().uint64(n).finish())!==hex(varint(n))){bad++;if(n<2n**31n||n>=2n**32n)outside++}}
const from=LongBits.fromBigInt;LongBits.fromBigInt=function(n){const b=from.call(this,n);b.lo >>>=0;b.hi >>>=0;return b};let after=0;for(const n of values)if(hex(createWriter().uint64(n).finish())!==hex(varint(n)))after++;
LongBits.fromBigInt=from;Buffer.allocUnsafe=original;
console.log({tested:values.length,bad,outside,afterUnsignedNormalization:after});
// A literal "every output is corrupt" is too strong: unwritten bytes can accidentally be correct.
Buffer.allocUnsafe=n=>{const b=original(n).fill(0);if(n===14){b.set([0x81,0x80,0x80,0x08],4);b.set([0x81,0x80,0x80,0x08],10)}return b};
const n=2147483776n;const b=new UnixFS({type:'file',blockSizes:[n]}).marshal();Buffer.allocUnsafe=original;
console.log('preseeded valid output',hex(b),'equals independent',hex(b)===hex([8,2,24,...varint(n),32,...varint(n)]));
