export const KEY = 'mofish.v1';
export const MAX_FISH = 12;
export const SPECIES = [
  {name:'落日金', color:'#eeac64', accent:'#e47851'},
  {name:'薄荷青', color:'#91cebc', accent:'#438c90'},
  {name:'月光银', color:'#dae4de', accent:'#8ba9b1'},
  {name:'珊瑚粉', color:'#eeb3ac', accent:'#be777f'}
];
const clamp=(n,a,b)=>Math.min(b,Math.max(a,n));
export function makeFish(index=0, now=Date.now()) {
  return {id:globalThis.crypto.randomUUID(),name:['小满','泡泡','阿橘','小月'][index%4],species:index%4,born:now,growth:0,meals:0};
}
export function initial(now=Date.now()) {
  return {version:1,fish:[0,1,2].map(i=>makeFish(i,now)),plants:3,night:false,sound:false,savedAt:now};
}
export function validate(raw, now=Date.now()) {
  if(!raw || raw.version!==1 || !Array.isArray(raw.fish) || raw.fish.length<1 || raw.fish.length>MAX_FISH) throw new Error('存档格式不正确');
  const ids=new Set();
  const fish=raw.fish.map(f=>{
    if(!f || typeof f.id!=='string' || ids.has(f.id) || typeof f.name!=='string' || !Number.isInteger(f.species) || f.species<0 || f.species>=SPECIES.length || ![f.born,f.growth,f.meals].every(Number.isFinite)) throw new Error('鱼儿数据不完整');
    ids.add(f.id);
    return {id:f.id.slice(0,100),name:f.name.trim().slice(0,16)||'小鱼',species:f.species,born:clamp(f.born,0,now),growth:clamp(f.growth,0,1),meals:clamp(Math.floor(f.meals),0,1e6)};
  });
  return {version:1,fish,plants:clamp(Math.floor(Number(raw.plants)||0),0,8),night:raw.night===true,sound:raw.sound===true,savedAt:Number.isFinite(raw.savedAt)?clamp(raw.savedAt,0,now):now};
}
export function catchUp(state, now=Date.now()) {
  const hours=clamp((now-state.savedAt)/3600000,0,24);
  state.fish.forEach(f=>f.growth=clamp(f.growth+hours*.008,0,1));
  state.savedAt=now;
  return hours;
}
export function eat(fish) {fish.meals++;fish.growth=clamp(fish.growth+.015,0,1);}
// Storage adapter: replace this boundary with account-based cloud sync in phase two.
export function createStorage(storage) {
  return {load(){const raw=storage.getItem(KEY);return raw?validate(JSON.parse(raw)):null;},save(state){storage.setItem(KEY,JSON.stringify(state));}};
}
