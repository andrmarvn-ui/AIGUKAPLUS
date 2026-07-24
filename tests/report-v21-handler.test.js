import test from "node:test";
import assert from "node:assert/strict";
import { installReportRoutes } from "../report-handler.js";

function makeApp(){
  const routes=new Map();
  return {
    get(path,handler){routes.set(path,handler);},
    route(path){return routes.get(path);}
  };
}

function makeResponse(){
  return {
    statusCode:200,
    headers:new Map(),
    payload:null,
    setHeader(name,value){this.headers.set(String(name).toLowerCase(),String(value));},
    status(code){this.statusCode=code;return this;},
    json(value){this.payload=value;return this;},
    send(value){this.payload=value;return this;}
  };
}

test("V2.1 report requests are coalesced and cached",async()=>{
  const originalFetch=globalThis.fetch;
  const originalDefault=process.env.AIGUKA_REPORT_V21_DEFAULT;
  process.env.AIGUKA_REPORT_V21_DEFAULT="false";
  let calls=0;
  globalThis.fetch=async(url,options)=>{
    calls+=1;
    assert.match(String(url),/v8_report_summary_v21$/);
    assert.equal(options.method,"POST");
    await new Promise(resolve=>setTimeout(resolve,15));
    return new Response(JSON.stringify({ok:true,version:"2.1-shadow",data:{conversations:6}}),{
      status:200,headers:{"content-type":"application/json"}
    });
  };

  try{
    const app=makeApp();
    installReportRoutes(app,{supabaseUrl:"https://example.supabase.co",publishableKey:"test-key"});
    const handler=app.route("/functions/v1/aiguka-v8-report-api");
    assert.equal(typeof handler,"function");

    const query={action:"summary",version:"2.1",from:"2026-07-24",to:"2026-07-24"};
    const res1=makeResponse();
    const res2=makeResponse();
    await Promise.all([
      handler({query,headers:{}},res1),
      handler({query,headers:{}},res2)
    ]);

    assert.equal(calls,1);
    assert.equal(res1.payload.data.conversations,6);
    assert.equal(res2.payload.data.conversations,6);
    assert.deepEqual(
      new Set([res1.headers.get("x-aiguka-cache"),res2.headers.get("x-aiguka-cache")]),
      new Set(["MISS","COALESCED"])
    );
    assert.equal(res1.headers.get("x-aiguka-report-version"),"2.1-shadow");

    const res3=makeResponse();
    await handler({query,headers:{}},res3);
    assert.equal(calls,1);
    assert.equal(res3.headers.get("x-aiguka-cache"),"HIT");
  }finally{
    globalThis.fetch=originalFetch;
    if(originalDefault===undefined)delete process.env.AIGUKA_REPORT_V21_DEFAULT;
    else process.env.AIGUKA_REPORT_V21_DEFAULT=originalDefault;
  }
});

test("legacy remains the default until the cutover flag is enabled",async()=>{
  const originalFetch=globalThis.fetch;
  const originalDefault=process.env.AIGUKA_REPORT_V21_DEFAULT;
  process.env.AIGUKA_REPORT_V21_DEFAULT="false";
  let calledUrl="";
  globalThis.fetch=async(url)=>{
    calledUrl=String(url);
    return new Response(JSON.stringify({ok:true,data:{}}),{status:200});
  };
  try{
    const app=makeApp();
    installReportRoutes(app,{supabaseUrl:"https://example.supabase.co",publishableKey:"test-key"});
    const handler=app.route("/functions/v1/aiguka-v8-report-api");
    const res=makeResponse();
    await handler({query:{action:"summary",from:"2026-07-24",to:"2026-07-24"},headers:{}},res);
    assert.match(calledUrl,/v8_report_summary_test$/);
    assert.equal(res.headers.get("x-aiguka-report-version"),"1");
  }finally{
    globalThis.fetch=originalFetch;
    if(originalDefault===undefined)delete process.env.AIGUKA_REPORT_V21_DEFAULT;
    else process.env.AIGUKA_REPORT_V21_DEFAULT=originalDefault;
  }
});
