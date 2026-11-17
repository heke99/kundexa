// Optional, operator-reviewed destinations. Never accept a destination from a request.
export function informationDestination(value:string|undefined):string|null{
 if(!value)return null;try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.toString():null;}catch{return null;}
}
