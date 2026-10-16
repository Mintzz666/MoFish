import {cp,rm,mkdir} from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});
await mkdir('dist',{recursive:true});
await cp('web','dist',{recursive:true});
console.log('Built static aquarium in dist/');
