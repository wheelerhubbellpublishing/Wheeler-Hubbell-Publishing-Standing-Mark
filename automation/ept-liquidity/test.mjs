import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,sign,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PREFIX,ID,canonical,makeOffer,validateQuote,openStore,recordQuote,createApp,schema} from './server.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const now=Date.now();
const offer=makeOffer('https://liquidity.example','LIVE');
const keys=generateKeyPairSync('ed25519');
function fixture(mode='PURCHASE',o=offer){return {version:'1.0.0',environment:o.environment,origin:new URL(o.endpoints.offer).origin,offer_id:ID,
  offer_sha256:hash(canonical(o)),quote_id:randomBytes(12).toString('hex'),nonce:randomBytes(32).toString('hex'),
  issued_at:new Date(now-1000).toISOString(),expires_at:new Date(now+3600000).toISOString(),mode,
  capital_provider:{name:'LOCAL TEST FIXTURE - NOT EXTERNAL CAPITAL',signing_key_sha256:hash(keys.publicKey.export({type:'spki',format:'der'})),wallet:'0x0000000000000000000000000000000000000001',authority_reference:'synthetic-local-test'},
  funding:{currency:'USDC',gross:'200',net_to_seller:'195',withheld_costs:'5',provider_borne_costs:'0',cost_breakdown:[{description:'declared withholding',amount:'5'}]},
  acquired_or_collateral_face_usd:'500.00',repayment:mode==='PURCHASE'?null:{obligor:'Justin Bowen',principal:'200',total_due:'210',maturity:new Date(now+86400000).toISOString(),interest_and_fee_terms:'10 USDC total charge',surplus_treatment:'Return surplus subject to applicable priority rules'},
  recourse:{ordinary_obligor_nonpayment:'payment-right terms only',direct_borrower_recourse:false,seller_representation_recourses:[],terms:'Local fixture only'},
  exclusions:o.exclusions,approval:{additional_human_review_required:false,standing_authority_reference:'local-test-only',remaining_programmatic_conditions:[]},
  settlement:{network:o.settlement.network,asset:'USDC',funding_deadline:new Date(now+7200000).toISOString(),execution_method:'test-no-transfer',execution_reference:'NOT_A_LIVE_EXECUTION_TARGET'},documents:[]};}
function signed(q){return {quote:q,authorization:{scheme:'Ed25519',public_key:keys.publicKey.export({format:'jwk'}),signature:sign(null,Buffer.from(PREFIX+canonical(q)),keys.privateKey).toString('hex')}};}
function reject(name,modify,pattern){test(name,()=>{const q=fixture();modify(q);assert.throws(()=>validateQuote(signed(q),offer,now),pattern);});}
test('stable canonical key order and lossless decimal strings',()=>{assert.equal(canonical({b:'1.00',a:true}),'\u007b"a":true,"b":"1.00"\u007d');assert.throws(()=>canonical({amount:1}),/ONLY_STRINGS/);});
test('recursive depth bounded',()=>{let x='a';for(let i=0;i<20;i++)x={x};assert.throws(()=>canonical(x),/TOO_DEEP/);});
test('LIVE requires HTTPS canonical origin',()=>{assert.throws(()=>makeOffer('http://example.com','LIVE'));assert.throws(()=>makeOffer('https://example.com/','LIVE'));});
test('signed purchase is valid without loan fields',()=>assert.equal(validateQuote(signed(fixture()),offer,now).signature_verified,true));
test('signed secured advance has equal standing',()=>assert.equal(validateQuote(signed(fixture('SECURED_ADVANCE')),offer,now).signature_verified,true));
test('signature does not imply verified capital or control',()=>{const db=openStore(':memory:');const r=recordQuote(db,signed(fixture()),offer,now).receipt;assert.equal(r.capital_commitment_verified,false);assert.equal(r.wallet_control_verified,false);assert.equal(r.accepted,false);assert.equal(r.live_completion_proven,false);db.close();});
reject('wrong environment rejected',q=>q.environment='TEST',/BINDING/);
reject('wrong origin rejected',q=>q.origin='https://other.example',/BINDING/);
reject('changed offer hash rejected',q=>q.offer_sha256='0'.repeat(64),/BINDING/);
reject('stale quote rejected',q=>{q.issued_at=new Date(now-7200000).toISOString();q.expires_at=new Date(now-1000).toISOString();},/NOT_CURRENT/);
reject('future issuance rejected',q=>q.issued_at=new Date(now+120000).toISOString(),/NOT_CURRENT/);
reject('impossible date rejected',q=>q.issued_at='2026-02-30T00:00:00.000Z',/WINDOW/);
reject('extra hidden field rejected',q=>q.blanket_lien=true,/SCHEMA/);
reject('excluded guarantee rejected',q=>q.exclusions=q.exclusions.filter(x=>x!=='PERSONAL_GUARANTEE'),/EXCLUSIONS/);
reject('human underwriting branch rejected',q=>q.approval.additional_human_review_required=true,/MACHINE/);
reject('gross-net arithmetic rejected',q=>q.funding.net_to_seller='196',/MATH/);
reject('fee breakout mismatch rejected',q=>q.funding.cost_breakdown=[],/BREAKDOWN/);
reject('negative monetary amount rejected',q=>q.funding.gross='-200',/DECIMAL/);
reject('exponential amount rejected',q=>q.funding.gross='2e2',/DECIMAL/);
reject('zero funding rejected',q=>{q.funding.gross='0';q.funding.net_to_seller='0';},/MATH/);
reject('USD right cannot be overallocated',q=>q.acquired_or_collateral_face_usd='15000.01',/FACE/);
reject('chain mismatch rejected',q=>q.settlement.network='eip155:84532',/SETTLEMENT/);
reject('purchase cannot conceal loan repayment',q=>q.repayment={},/HIDE_REPAYMENT/);
test('tampering invalidates signature',()=>{const e=signed(fixture());e.quote.funding.net_to_seller='194';e.quote.funding.withheld_costs='6';e.quote.funding.cost_breakdown[0].amount='6';assert.throws(()=>validateQuote(e,offer,now),/SIGNATURE_INVALID/);});
test('invalid signature key binding rejected',()=>{const e=signed(fixture());e.authorization.public_key=generateKeyPairSync('ed25519').publicKey.export({format:'jwk'});assert.throws(()=>validateQuote(e,offer,now),/KEY_MISMATCH/);});
test('nonce and quote id conflicts rejected',()=>{const db=openStore(':memory:');const q=fixture();recordQuote(db,signed(q),offer,now);q.funding.provider_borne_costs='1';assert.throws(()=>recordQuote(db,signed(q),offer,now),/CONFLICT/);db.close();});
test('exact retries replay stable receipt even after expiry',()=>{const db=openStore(':memory:');const e=signed(fixture());const a=recordQuote(db,e,offer,now);const b=recordQuote(db,e,offer,now+7200000);assert.equal(a.status,201);assert.equal(b.status,200);assert.deepEqual(a.receipt,b.receipt);assert.equal(db.prepare('SELECT COUNT(*) n FROM quotes').get().n,1);db.close();});
test('receipt survives database close and reopen',()=>{const dir=mkdtempSync(join(tmpdir(),'whp-'));try{const p=join(dir,'quotes.sqlite');let db=openStore(p);const e=signed(fixture());const a=recordQuote(db,e,offer,now);db.close();db=openStore(p);assert.deepEqual(recordQuote(db,e,offer,now).receipt,a.receipt);db.close();}finally{rmSync(dir,{recursive:true,force:true});}});
test('failed validation leaves no persisted quote',()=>{const db=openStore(':memory:');const q=fixture();q.expires_at=new Date(now-10).toISOString();assert.throws(()=>recordQuote(db,signed(q),offer,now));assert.equal(db.prepare('SELECT COUNT(*) n FROM quotes').get().n,0);db.close();});
test('schema contains both alternatives without preferred mode',()=>{assert.deepEqual(schema().properties.quote.properties.mode.enum,['PURCHASE','SECURED_ADVANCE']);assert.equal(offer.funding.mode_preference,null);});
test('HTTP discovery, validation, persistence, retrieval and clear disabled settlement',async()=>{
 const db=openStore(':memory:');const o=makeOffer('http://localhost','TEST');const app=createApp({origin:'http://localhost',environment:'TEST',db});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 try{
 const g=await fetch(base+`/liquidity/offers/${ID}`);assert.equal(g.status,200);assert.equal((await g.json()).asset.face_value.amount,'15000.00');
 const e=signed(fixture('SECURED_ADVANCE',o));
 const v=await fetch(base+`/liquidity/offers/${ID}/validate-quote`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e)});assert.equal(v.status,200);assert.equal(db.prepare('SELECT COUNT(*) n FROM quotes').get().n,0);
 const p=await fetch(base+`/liquidity/offers/${ID}/quote`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(e)});assert.equal(p.status,201);const receipt=await p.json();
 const r=await fetch(base+new URL(receipt.receipt_url).pathname);assert.deepEqual(await r.json(),receipt);
 const count=await (await fetch(base+`/liquidity/offers/${ID}/activity`)).json();assert.equal(count.signed_quotes_recorded,1);assert.equal(count.settlements,0);
 assert.equal((await fetch(base+`/liquidity/offers/${ID}/accept`,{method:'POST'})).status,405);
 assert.equal((await fetch(base+`/liquidity/offers/${ID}/quote`,{method:'POST',body:'{}'})).status,415);
 assert.equal((await fetch(base+`/liquidity/offers/${ID}/quote`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);
 assert.equal((await fetch(base+'/healthz',{headers:{Origin:'https://unrelated.example'}})).status,403);
 assert.equal((await (await fetch(base+'/healthz')).json()).settlement_enabled,false);
 }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));db.close();}
});
test('without durable store, discovery works and intake refuses to lose a quote',async()=>{
 const {server}=createApp({origin:'https://liquidity.example',environment:'LIVE'});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{assert.equal((await fetch(base+`/liquidity/offers/${ID}`)).status,200);assert.equal((await fetch(base+'/readyz')).status,503);assert.equal((await fetch(base+`/liquidity/offers/${ID}/quote`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(signed(fixture()))})).status,503);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
