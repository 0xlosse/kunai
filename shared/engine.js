/* KUNAI shared rules engine: used by the server (authoritative) and the browser (solo + UI checks) */
const ELS=['F','W','A','T'];
const EL={F:{n:'Blaze',v:'--fire'},W:{n:'Tide',v:'--water'},A:{n:'Glitch',v:'--wind'},T:{n:'Volt',v:'--thunder'}};
const cc=c=>c[0], cv=c=>c.slice(1);
const VAL={S:'Block',R:'Rewind',D:'Spray +2'};
function cardName(c,col){
  if(c==='XW')return 'Wildstyle'+(col?` (${EL[col].n})`:'');
  if(c==='X+')return 'Bomb +4'+(col?` (${EL[col].n})`:'');
  return `${EL[cc(c)].n} ${VAL[cv(c)]||cv(c)}`;
}
const pts=c=>{const v=cv(c);if(cc(c)==='X')return 50;if(/\d/.test(v))return +v;return 20;};
function esc(t){return String(t).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
/* ================= engine ================= */
function buildDeck(){
  const d=[];
  for(const e of ELS){d.push(e+'0');for(const v of ['1','2','3','4','5','6','7','8','9','S','R','D']){d.push(e+v,e+v);}}
  for(let i=0;i<4;i++)d.push('XW','X+');
  return shuffle(d);
}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.random()*(i+1)|0;[a[i],a[j]]=[a[j],a[i]];}return a;}
const nextSeat=(s,from,k=1)=>{const n=s.players.length;return ((from+s.dir*k)%n+n*4)%n;};
function logp(s,msg){s.log.push(msg);if(s.log.length>3)s.log.shift();}
const nm=(s,i)=>esc(s.players[i].name);

function newGame(players,settings){
  const s={v:0,fxn:0,fx:null,playn:0,lastPlay:null,players:players.map(p=>({...p,hand:[],score:0,chakra:0,frozen:false})),settings,round:0,dealer:-1,log:[],deck:[],discard:[]};
  newRound(s);return s;
}
function newRound(s){
  s.round++;s.dealer=(s.dealer+1)%s.players.length;
  s.deck=buildDeck();s.discard=[];
  s.players.forEach(p=>{p.hand=[];p.chakra=0;p.frozen=false;});
  for(let r=0;r<7;r++)s.players.forEach((p,i)=>drawCards(s,i,1));
  let top=s.deck.pop();
  while(!/\d/.test(cv(top))){s.deck.unshift(top);top=s.deck.pop();}
  s.discard.push(top);s.top=top;s.color=cc(top);s.dir=1;
  s.turn=(s.dealer+1)%s.players.length;s.pendingDraw=0;s.drew=false;s.pending=null;
  s.phase='play';s.winner=null;s.lastPts=0;s.log=[];
  logp(s,`Round ${s.round}. First card: <b>${cardName(top)}</b>.`);
}
function drawCards(s,i,k){
  let got=0;
  for(let n=0;n<k;n++){
    if(!s.deck.length){const keep=s.discard.pop();s.deck=shuffle(s.discard);s.discard=keep?[keep]:[];}
    if(!s.deck.length)break;
    s.players[i].hand.push(s.deck.pop());got++;
  }
  return got;
}
function isLegal(s,c){
  if(s.pendingDraw>0){
    if(!s.settings.stack)return false;
    if(c==='X+')return true;
    return cv(s.top)==='D'&&cv(c)==='D';
  }
  return cc(c)==='X'||cc(c)===s.color||cv(c)===cv(s.top);
}
function setFx(s,k,seat){s.fx={id:++s.fxn,k,seat};}
function applyEffect(s,seat,c,col){
  if(!/\d/.test(cv(c)))setFx(s,cv(c),seat);
  s.lastPlay={seat,id:++s.playn};
  s.top=c;s.color=cc(c)==='X'?col:cc(c);s.drew=false;
  const v=cv(c),n=s.players.length,who=nm(s,seat);
  if(v==='S'){const t=nextSeat(s,seat);logp(s,`<b>${who}</b> throws a Block. <b>${nm(s,t)}</b> is skipped.`);s.turn=nextSeat(s,seat,2);}
  else if(v==='R'){
    if(n===2){s.turn=seat;logp(s,`<b>${who}</b> hits Rewind and goes again.`);}
    else{s.dir*=-1;s.turn=nextSeat(s,seat);logp(s,`<b>${who}</b> reverses the order.`);}
  }
  else if(v==='D'||v==='+'){
    const k=v==='D'?2:4;
    if(s.settings.stack){s.pendingDraw+=k;s.turn=nextSeat(s,seat);logp(s,`<b>${who}</b> plays ${cardName(c,col)}. Penalty is now <b>+${s.pendingDraw}</b>.`);}
    else{const t=nextSeat(s,seat);drawCards(s,t,k);logp(s,`<b>${who}</b> plays ${cardName(c,col)}. <b>${nm(s,t)}</b> draws ${k} and is skipped.`);s.turn=nextSeat(s,seat,2);}
  }
  else{s.turn=nextSeat(s,seat);logp(s,`<b>${who}</b> plays ${cardName(c,col)}.`);}
  if(s.players[seat].hand.length===0){
    if(s.pendingDraw>0){const t=nextSeat(s,seat);drawCards(s,t,s.pendingDraw);s.pendingDraw=0;}
    endRound(s,seat);
  }
}
function endRound(s,w){
  const p=s.players.reduce((a,pl,i)=>i===w?a:a+pl.hand.reduce((b,c)=>b+pts(c),0),0);
  s.winner=w;s.lastPts=p;setFx(s,'WIN',w);s.players[w].score+=p;
  const t=s.settings.target;
  s.phase=(!t||s.players[w].score>=t)?'over':'round';
  logp(s,`<b>${nm(s,w)}</b> empties their hand and wins the round (+${p}).`);
}
const CHMAX=4;
const SKILLS=[
  {n:'Freeze Frame',d:'Freeze the next rival. They lose their next turn.'},
  {n:'Flame Cut',d:'Burn away any one card from your hand.'},
  {n:'Void Swap',d:'Give a rival a card you pick and steal a random one from them.'},
  {n:'Glitch Shift',d:'Hack the active color to any color.'},
  {n:'Volt Strike',d:'Zap the next rival: they draw 2.'},
  {n:'Remix',d:'Reshuffle your hand into the deck and draw one card fewer.'}
];
const charge=(s,i)=>{const p=s.players[i];if(p)p.chakra=Math.min(CHMAX,(p.chakra||0)+1);};
function settle(s){
  if(s.phase!=='play'||s.pending)return;
  for(let g=0;g<8&&s.players[s.turn].frozen;g++){
    const t=s.turn;s.players[t].frozen=false;
    if(s.pendingDraw>0){drawCards(s,t,s.pendingDraw);logp(s,`<b>${nm(s,t)}</b> is frozen, takes +${s.pendingDraw} and loses the turn.`);s.pendingDraw=0;}
    else logp(s,`<b>${nm(s,t)}</b> is frozen and loses the turn.`);
    s.turn=nextSeat(s,t);s.drew=false;
  }
}
function useSkill(s,seat,a){
  const P=s.players[seat];
  if(!s.settings.skills)return 'Skills are off';
  if((P.chakra||0)<CHMAX)return 'Chakra is not full yet';
  if(s.pendingDraw>0)return 'Deal with the penalty first';
  if(s.drew)return 'Use your skill before drawing';
  const k=P.av%6,who=nm(s,seat);
  if(k===0){const t=nextSeat(s,seat);if(t===seat)return 'No rival to freeze';s.players[t].frozen=true;logp(s,`<b>${who}</b> hits <b>${nm(s,t)}</b> with Freeze Frame.`);}
  else if(k===1){const i=a.i|0;if(!P.hand[i])return 'Pick a card to cut';if(P.hand.length<2)return 'Keep at least one card';const c=P.hand.splice(i,1)[0];s.discard.unshift(c);logp(s,`<b>${who}</b> burns away ${cardName(c)}.`);}
  else if(k===2){const t=a.target|0,T=s.players[t];if(t===seat||!T||!T.hand.length)return 'Pick a rival';const i=a.i|0;if(!P.hand[i])return 'Pick a card to give';
    const mine=P.hand.splice(i,1)[0],j=Math.random()*T.hand.length|0,got=T.hand.splice(j,1)[0];T.hand.push(mine);P.hand.push(got);logp(s,`<b>${who}</b> swaps a card with <b>${nm(s,t)}</b> through the void.`);}
  else if(k===3){if(!ELS.includes(a.col))return 'Pick an element';s.color=a.col;logp(s,`<b>${who}</b> glitches the color to <b>${EL[a.col].n}</b>.`);}
  else if(k===4){const t=nextSeat(s,seat);if(t===seat)return 'No rival';drawCards(s,t,2);logp(s,`<b>${who}</b> zaps <b>${nm(s,t)}</b>: +2.`);}
  else{const n=P.hand.length;if(n<2)return 'You need at least 2 cards';s.deck.push(...P.hand);P.hand=[];shuffle(s.deck);drawCards(s,seat,n-1);logp(s,`<b>${who}</b> remixes the hand and redraws ${n-1}.`);}
  P.chakra=0;setFx(s,'SK'+k,seat);return null;
}
function act(s,seat,a){const e=actCore(s,seat,a);if(!e)settle(s);return e;}
/* returns error text, or null on success */
function actCore(s,seat,a){
  if(!a||typeof a!=='object')return 'Bad move';
  const P=s.players[seat];if(!P)return 'Not seated';
  if(a.t==='next'){if(seat!==0||s.phase!=='round')return 'Only the host starts the next round';newRound(s);return null;}
  if(a.t==='again'){if(seat!==0||s.phase!=='over')return 'Only the host can restart';s.players.forEach(p=>p.score=0);s.round=0;newRound(s);return null;}
  if(s.phase!=='play')return 'Round is over';
  if(a.t==='respond'){
    const p=s.pending;if(!p||p.target!==seat)return 'Nothing to answer';
    s.pending=null;
    if(!a.liar){
      s.discard.push(p.actual);charge(s,p.by);logp(s,`<b>${nm(s,seat)}</b> believes it.`);applyEffect(s,p.by,p.claim,p.col);return null;
    }
    if(p.actual===p.claim){
      setFx(s,'TRUTH',p.by);drawCards(s,seat,2);logp(s,`<b>${nm(s,seat)}</b> calls Liar! It really was ${cardName(p.claim,p.col)}. <b>${nm(s,seat)}</b> draws 2.`);
      s.discard.push(p.actual);charge(s,p.by);applyEffect(s,p.by,p.claim,p.col);return null;
    }
    setFx(s,'CAUGHT',seat);s.players[p.by].hand.push(p.actual);drawCards(s,p.by,4);
    logp(s,`<b>${nm(s,seat)}</b> calls Liar! It was ${cardName(p.actual)}, not ${cardName(p.claim)}. <b>${nm(s,p.by)}</b> takes it back and draws 4.`);
    s.turn=seat;s.drew=false;return null;
  }
  if(s.pending)return 'Waiting for an answer to the face-down card';
  if(s.turn!==seat)return 'Not your turn';
  if(a.t==='skill')return useSkill(s,seat,a);
  if(a.t==='play'){
    const i=a.i|0,c=P.hand[i];if(!c)return 'No such card';
    if(s.drew&&i!==P.hand.length-1)return 'You can only play the card you just drew';
    if(a.bluff){
      if(!s.settings.bluff)return 'Bluffing is off';
      if(s.pendingDraw>0)return 'You cannot bluff against a penalty';
      const cl=a.claim;if(typeof cl!=='string'||!/^([FWAT]([0-9SRD])|X[W+])$/.test(cl))return 'Pick what you claim';
      if(!isLegal(s,cl))return 'Your claim must be a legal card';
      if(cc(cl)==='X'&&!ELS.includes(a.col))return 'Pick an element';
      P.hand.splice(i,1);
      s.pending={by:seat,target:nextSeat(s,seat),claim:cl,col:cc(cl)==='X'?a.col:null,actual:c};
      s.turn=s.pending.target;
      logp(s,`<b>${nm(s,seat)}</b> plays face-down and claims <b>${cardName(cl,s.pending.col)}</b>.`);
      return null;
    }
    if(!isLegal(s,c))return s.pendingDraw>0?`Stack a matching card or draw ${s.pendingDraw}`:'That card does not match';
    if(cc(c)==='X'&&!ELS.includes(a.col))return 'Pick an element';
    P.hand.splice(i,1);s.discard.push(c);charge(s,seat);applyEffect(s,seat,c,a.col);return null;
  }
  if(a.t==='draw'){
    if(s.pendingDraw>0){const k=s.pendingDraw;drawCards(s,seat,k);s.pendingDraw=0;s.turn=nextSeat(s,seat);s.drew=false;logp(s,`<b>${nm(s,seat)}</b> draws ${k}.`);return null;}
    if(s.drew)return 'You already drew. Play the drawn card or pass';
    let n=0;
    if(s.settings.until){for(let g=0;g<40;g++){if(!drawCards(s,seat,1))break;n++;if(isLegal(s,P.hand[P.hand.length-1]))break;}}
    else n=drawCards(s,seat,1);
    const last=P.hand[P.hand.length-1];
    if(!n||!isLegal(s,last)){s.turn=nextSeat(s,seat);s.drew=false;logp(s,`<b>${nm(s,seat)}</b> draws ${n} and passes.`);}
    else{s.drew=true;logp(s,`<b>${nm(s,seat)}</b> draws ${n}.`);}
    return null;
  }
  if(a.t==='pass'){if(!s.drew)return 'Draw first';s.drew=false;s.turn=nextSeat(s,seat);logp(s,`<b>${nm(s,seat)}</b> passes.`);return null;}
  return 'Unknown move';
}
function legalClaims(s){
  const out=[];
  for(const e of ELS)for(const v of ['0','1','2','3','4','5','6','7','8','9','S','R','D']){const c=e+v;if(isLegal(s,c))out.push(c);}
  out.push('XW','X+');return out;
}

/* ================= bots ================= */
function bestColor(hand){const k={F:0,W:0,A:0,T:0};hand.forEach(c=>{if(cc(c)!=='X')k[cc(c)]++;});return ELS.reduce((a,b)=>k[b]>k[a]?b:a,ELS[Math.random()*4|0]);}
function botAct(s,seat){
  const P=s.players[seat];
  if(s.pending&&s.pending.target===seat){
    const left=s.players[s.pending.by].hand.length;
    return {t:'respond',liar:Math.random()<(left<=2?.5:.27)};
  }
  const idx=P.hand.map((c,i)=>i).filter(i=>(!s.drew||i===P.hand.length-1)&&isLegal(s,P.hand[i]));
  if(s.settings.skills&&(P.chakra||0)>=CHMAX&&!s.drew&&s.pendingDraw===0){
    const k=P.av%6,nx=s.players[nextSeat(s,seat)].hand.length;
    const worst=()=>P.hand.map((c,i)=>i).sort((a,b)=>pts(P.hand[b])-pts(P.hand[a]))[0];
    if(k===0&&nx<=4)return {t:'skill'};
    if(k===1&&P.hand.length>=3)return {t:'skill',i:P.hand.map((c,i)=>i).filter(i=>!idx.includes(i)).sort((a,b)=>pts(P.hand[b])-pts(P.hand[a]))[0]??worst()};
    if(k===2&&P.hand.length>=3){let t=-1;s.players.forEach((q,j)=>{if(j!==seat&&q.hand.length&&(t<0||q.hand.length<s.players[t].hand.length))t=j;});if(t>=0)return {t:'skill',i:worst(),target:t};}
    if(k===3&&!idx.length)return {t:'skill',col:bestColor(P.hand)};
    if(k===4&&nx<=5)return {t:'skill'};
    if(k===5&&!idx.length&&P.hand.length>=4)return {t:'skill'};
  }
  if(s.settings.bluff&&!s.drew&&s.pendingDraw===0&&P.hand.length>1){
    const r=Math.random();
    if((!idx.length&&r<.4)||r<.07){
      const cl=legalClaims(s).filter(c=>cc(c)!=='X'||Math.random()<.15);
      const claim=cl[Math.random()*cl.length|0];
      const real=idx.length&&Math.random()<.4?idx[0]:Math.random()*P.hand.length|0;
      return {t:'play',i:real,bluff:true,claim:P.hand[real]===claim?claim:claim,col:bestColor(P.hand)};
    }
  }
  if(!idx.length)return s.drew?{t:'pass'}:{t:'draw'};
  const nxt=s.players[nextSeat(s,seat)].hand.length;
  const score=i=>{const c=P.hand[i],v=cv(c);if(cc(c)==='X')return nxt<=2?9:1;if('SRD'.includes(v))return nxt<=3?8:4;return 5+(+v)/10;};
  idx.sort((a,b)=>score(b)-score(a));
  const i=idx[0];return {t:'play',i,col:bestColor(P.hand.filter((c,j)=>j!==i))};
}


if(typeof module!=='undefined')module.exports={ELS,EL,cc,cv,cardName,pts,esc,buildDeck,shuffle,nextSeat,logp,newGame,newRound,drawCards,isLegal,act,legalClaims,botAct,CHMAX,SKILLS};
