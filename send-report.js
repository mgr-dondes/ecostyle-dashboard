const WH = "https://ecostyle.bitrix24.eu/rest/4/mc0jnypsq03nu8qu/";
const CHAT_ID = "chat284994";

async function bx(m,p={}){const r=await fetch(WH+m,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});if(!r.ok)throw new Error(m+": HTTP "+r.status);return r.json();}
async function bxAll(m,p={},k=null){let a=[],s=0;while(true){const d=await bx(m,{...p,start:s});let i=d.result;if(k&&i&&i[k])i=i[k];if(Array.isArray(i))a=a.concat(i);if(!d.next)break;s=d.next;}return a;}

function getReportDate(){
  const now=new Date();
  const kyiv=new Date(now.toLocaleString("en-US",{timeZone:"Europe/Kyiv"}));
  const dow=kyiv.getDay();
  let back=1;
  if(dow===1)back=3;else if(dow===0)back=2;else if(dow===6)back=1;
  const rd=new Date(kyiv);rd.setDate(rd.getDate()-back);
  const y=rd.getFullYear(),mo=String(rd.getMonth()+1).padStart(2,"0"),da=String(rd.getDate()).padStart(2,"0");
  return{ds:`${y}-${mo}-${da}`,dd:`${da}.${mo}.${y}`,dow};
}

function f(v){return v?` ${v} `:` - `;}

async function main(){
  const{ds,dd,dow}=getReportDate();
  if(dow===0||dow===6){console.log("Weekend skip");return;}
  console.log("Report for",ds);

  const[users,cre,comp,chg,crm]=await Promise.all([
    bxAll("user.get",{filter:{ACTIVE:true,USER_TYPE:"employee"}}),
    bxAll("tasks.task.list",{filter:{">=CREATED_DATE":ds},select:["id","createdBy"]},"tasks"),
    bxAll("tasks.task.list",{filter:{">=CLOSED_DATE":ds,STATUS:5},select:["id","responsibleId","createdBy","closedBy"]},"tasks"),
    bxAll("tasks.task.list",{filter:{">=CHANGED_DATE":ds},select:["id","responsibleId","createdBy","changedBy"]},"tasks"),
    bxAll("crm.activity.list",{filter:{">=CREATED":ds+"T00:00:00"},select:["ID","RESPONSIBLE_ID","AUTHOR_ID"]})
  ]);

  let imD;try{imD=await bx("im.recent.get");}catch(e){imD={result:[]};}
  const imI=Array.isArray(imD.result)?imD.result:(imD.result?.items||[]);
  const tChat=imI.filter(i=>i.message?.date&&String(i.message.date).includes(ds));
  const chatU={};
  for(const c of tChat.slice(0,50)){
    const did=c.type==="user"?String(c.id):"chat"+String(c.chat_id||c.id);
    try{const mr=await bx("im.dialog.messages.get",{DIALOG_ID:did,LIMIT:50});
    (mr.result?.messages||[]).forEach(m=>{if(m.date&&String(m.date).includes(ds)){const a=String(m.author_id||"");if(a&&a!=="0")chatU[a]=(chatU[a]||0)+1;}});}catch(e){}
  }

  const um={};
  users.forEach(u=>{const id=String(u.ID);um[id]={id,nm:`${u.LAST_NAME||""} ${u.NAME||""}`.trim(),cr:0,cx:0,ct:0,cm:0,ch:0,wk:0};});
  cre.forEach(t=>{const u=String(t.createdBy||"");if(u&&um[u])um[u].cr++;});
  comp.forEach(t=>{const r=String(t.responsibleId||""),c=String(t.createdBy||"");if(r&&um[r])um[r].cx++;if(c&&c!==r&&um[c])um[c].ct++;});
  const uT={};chg.forEach(t=>{const tid=String(t.id||"");[t.responsibleId,t.createdBy,t.changedBy].forEach(v=>{const u=String(v||"");if(u&&um[u]){if(!uT[u])uT[u]={};uT[u][tid]=1;}});});
  for(const uid in uT)if(um[uid])um[uid].wk=Object.keys(uT[uid]).length;
  crm.forEach(a=>{[a.RESPONSIBLE_ID,a.AUTHOR_ID].forEach(v=>{const u=String(v||"");if(u&&um[u])um[u].cm++;});});
  for(const uid in chatU)if(um[uid])um[uid].ch=chatU[uid];

  const active=Object.values(um).filter(u=>u.cr+u.cx+u.ct+u.cm+u.ch+u.wk>0);
  const total=Object.keys(um).length;
  const pct=total?Math.round(active.length/total*100):0;

  const sorted=[...active].sort((a,b)=>(b.cr+b.cx+b.ct+b.cm+b.ch+b.wk)-(a.cr+a.cx+a.ct+a.cm+a.ch+a.wk));

  let lines=[];
  sorted.forEach((u,i)=>{
    const pre=i===0?`1. [B]${u.nm}[/B]`:`${i+1}. ${u.nm}`;
    lines.push(`${pre}:   📝${f(u.cr)} ✅${f(u.cx)} 🔒${f(u.ct)} 💼${f(u.cm)} 💬${f(u.ch)} 📂${f(u.wk)}`);
  });

  const msg=`[B]📊 Активність команди в Битрикс24 за ${dd}[/B]\nАктивних співробітників: ${active.length} з ${total} (${pct}%)\n\n📝 створено задач\n✅ виконано задач\n🔒 закрито задач\n💼 CRM\n💬 дописів к задачам\n📂 редагування задач\n\n${lines.join("\n")}`;

  await bx("im.message.add",{DIALOG_ID:CHAT_ID,MESSAGE:msg,SYSTEM:"Y"});
  console.log("Sent report to group chat for",dd);
}
main().catch(e=>{console.error(e);process.exit(1);});
