// The plan half of navigation: what kind of question, which dates, which words. Pure and model-free. Identical in the desktop and hosted programs.
// Navigation for a large vault. A question is not a query: this plans the search (what kind of question, which dates, which words
// matter most), narrows the vault by selectivity and by folder, scores the survivors on several signals, and says how it got there.
// It replaces the old single "ask a model to re-rank what search already returned" step. No model is needed; if the caller supplies
// one to choose the question's kind, a failure is reported in `notices` and the rule-based plan is used.

export const INTENTS=['decision','recent','code','how','lookup'];
const STOP=new Set('is to on of we it as at be by do if in me my no or so up us an am are the and for are but not you all any can had her was one our out has have his how its may new now old see two who did get him let put say she too use what when where which while with from that this they them then than were will your about after again also been being could does into just like make more most much must only other over same should some such their there these those through under very would tell give show find said decided decide decision decisions latest recent recently today yesterday week month last please vault note notes'.split(' '));
const MONTHS={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};
const CAP=80;
const stem=t=>{if(t.length<5)return t;const r=t.replace(/(ations?|ings?|ed|es|ly|s)$/,'');return r.length>=3?r:t;};
const pad=n=>String(n).padStart(2,'0');
const ymd=d=>`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
// A day that is not on the calendar is not a date. Date.UTC is used so a local zone cannot roll the day; February 30 must not become March.
const onCalendar=(y,m,d)=>{const t=new Date(Date.UTC(y,m-1,d));return t.getUTCFullYear()===y&&t.getUTCMonth()===m-1&&t.getUTCDate()===d;};
const keep=(y,m,d)=>onCalendar(y,m,d)?`${y}-${pad(m)}-${pad(d)}`:null;

// The plan: a typed decision with a closed set of answers. Rules decide unless a model is supplied.
export function planQuestion(question,{now=new Date(),year=now.getUTCFullYear()}={}){
 const q=String(question||'').slice(0,500),lower=q.toLowerCase(),dates=new Set();
 for(const m of q.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)){const k=keep(+m[1],+m[2],+m[3]);if(k)dates.add(k);}
 for(const m of lower.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\b/g)){const k=keep(year,MONTHS[m[2]],+m[1]);if(k)dates.add(k);}
 for(const m of lower.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)){const k=keep(year,MONTHS[m[1]],+m[2]);if(k)dates.add(k);}
 if(/\btoday\b/.test(lower))dates.add(ymd(now));
 if(/\byesterday\b/.test(lower))dates.add(ymd(new Date(now.getTime()-864e5)));
 let sinceDays=null;const span=/\b(?:last|past)\s+(\d{1,3})\s+(day|week|month)s?\b/.exec(lower);
 if(span)sinceDays=Number(span[1])*({day:1,week:7,month:30})[span[2]];else if(/\b(this|last) week\b/.test(lower))sinceDays=7;else if(/\b(this|last) month\b/.test(lower))sinceDays=30;
 let intent='lookup';const why=[];
 if(/\b(decid|decision|approv|ruled|ruling|agreed|chose|verdict|vinny said|did vinny|who approved)/.test(lower)){intent='decision';why.push('asks what was decided or approved');}
 else if(dates.size||sinceDays||/\b(latest|recent|newest|what changed|changed since|just now)\b/.test(lower)){intent='recent';why.push('asks about a time');}
 else if(/\b[a-z]+[A-Z]\w+\(|\.(mjs|js|ts|py)\b|\bfunction\b|\bcaller|\bcallee|\bsymbol\b|\bwhere is .* (defined|implemented)/.test(q)){intent='code';why.push('names code');}
 else if(/\b(how (do|to|can|should)|steps?|procedure|sop|checklist|process)\b/.test(lower)){intent='how';why.push('asks for a procedure');}
 else why.push('plain lookup');
 const raw=q.match(/[\p{L}\p{N}_-]{2,}/gu)||[],seen=new Set(),terms=[];
 for(const word of raw){
  const w=word.toLowerCase();if(w.length<3&&!/\d/.test(w)||STOP.has(w)||seen.has(w)||/^\d{4}-\d{2}-\d{2}$/.test(w))continue;seen.add(w);
  const entity=/\d/.test(word)||/[-_]/.test(word)||(/[A-Z]/.test(word.slice(1))&&word.length>3)||(/^[A-Z]{2,}$/.test(word));
  terms.push({term:stem(w),word:w,entity});
 }
 // Words people split that the vault joins ("take over" is TAKEOVER in a file name): offered as extra evidence, never required.
 const joined=[];for(let i=0;i+1<raw.length;i++){const a=raw[i].toLowerCase(),b=raw[i+1].toLowerCase();if(a.length>=3&&b.length>=3&&!/\d/.test(a+b))joined.push(a+b);}
 return {schema:'adamantium.navigation.plan/v1',intent,why,method:'rules',dates:[...dates],sinceDays,terms:terms.slice(0,10),joined:joined.slice(0,6)};
}
