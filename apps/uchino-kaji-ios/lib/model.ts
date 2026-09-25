export type Status='a'|'b'|'both'|'none'|'unset';
export type Version={effective:string;name:string;category:string;weight:number;kind:'days'|'months'|'weekdays'|'ondemand';every:number;weekdays:number[];start:string;active:boolean;source:string};
export type Chore={id:string;revision:number;versions:Version[]};
export type Entry={choreId:string;date:string;status:Status;weight:number;name:string;category:string;revision:number};
export type Settings={name:string;a:string;b:string;revision:number};
export type State={chores:Chore[];entries:Entry[];settings:Settings;today:string};
export function todayJP(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
export function validDate(s:string){return /^\d{4}-\d{2}-\d{2}$/.test(s)&&s>='2000-01-01'&&s<='2100-12-31'&&!Number.isNaN(Date.parse(s))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s}
export function versionAt(c:Chore,date:string){return [...c.versions].reverse().find(v=>v.effective<=date)}
export function due(v:Version|undefined,date:string){if(!v?.active||date<v.start)return false;const d=new Date(date+'T00:00:00Z'),s=new Date(v.start+'T00:00:00Z');if(v.kind==='ondemand')return false;if(v.kind==='weekdays')return v.weekdays.includes(d.getUTCDay());if(v.kind==='months'){const diff=(d.getUTCFullYear()-s.getUTCFullYear())*12+d.getUTCMonth()-s.getUTCMonth();const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();return diff%v.every===0&&d.getUTCDate()===Math.min(s.getUTCDate(),last)}return Math.round((d.getTime()-s.getTime())/86400000)%v.every===0}
export function monthDays(month:string){const [y,m]=month.split('-').map(Number);return Array.from({length:new Date(Date.UTC(y,m,0)).getUTCDate()},(_,i)=>month+'-'+String(i+1).padStart(2,'0'))}
export function summary(entries:Entry[]){let a=0,b=0,done=0,skipped=0;for(const e of entries){if(e.status==='a'){a+=e.weight;done++}if(e.status==='b'){b+=e.weight;done++}if(e.status==='both'){a+=e.weight/2;b+=e.weight/2;done++}if(e.status==='none')skipped++}return {a,b,done,skipped,total:a+b,percent:a+b?Math.round(a/(a+b)*100):null}}
export function frequency(v:Pick<Version,'kind'|'every'|'weekdays'>){if(v.kind==='ondemand')return '必要なとき';if(v.kind==='weekdays')return v.weekdays.map(x=>'日月火水木金土'[x]).join('・')+'曜';if(v.kind==='months')return v.every===1?'月に1回':v.every+'か月に1回';return v.every===1?'毎日':v.every===7?'週に1回':v.every+'日に1回'}
