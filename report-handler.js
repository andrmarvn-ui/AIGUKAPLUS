import * as XLSX from "xlsx";

export function installReportRoutes(app,{supabaseUrl,publishableKey}){
  const headers=()=>({
    apikey:publishableKey,
    authorization:`Bearer ${publishableKey}`,
    "content-type":"application/json",
    "x-aiguka-railway-test":"enabled"
  });

  async function rpc(name,args={}){
    if(!publishableKey)throw Error("MISSING_SUPABASE_PUBLISHABLE_KEY");
    const r=await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`,{
      method:"POST",headers:headers(),body:JSON.stringify(args),
      signal:AbortSignal.timeout(60000),cache:"no-store"
    });
    const t=await r.text();let j;try{j=JSON.parse(t)}catch{j={raw:t.slice(0,500)}}
    if(!r.ok)throw Error(j?.message||j?.error||`RPC_HTTP_${r.status}`);
    return j;
  }

  function args(q,limit=null){
    const v=n=>{const x=String(q[n]??"").trim();return x||null};
    return {
      p_from:v("from"),p_to:v("to"),p_page_id:v("page_id"),
      p_ad_account_id:v("ad_account_id"),p_campaign_id:v("campaign_id"),
      p_adset_id:v("adset_id"),p_ad_id:v("ad_id"),p_search:v("search"),
      p_limit:limit??Math.min(Math.max(Number(q.limit||100),1),10000),
      p_offset:Math.max(Number(q.offset||0),0)
    };
  }

  function sourceLabel(row={}){
    if(row.customer_source_type==="comment")return "Bình luận Facebook";
    if(row.ad_id)return "Quảng cáo Meta";
    if(row.source_channel==="legacy_webhook_inbox"||row.customer_source_type==="message")return "Messenger / tự nhiên";
    return row.source_channel||row.identity_source||"Tự nhiên / chưa xác định";
  }

  function exportRows(rows,type){
    if(type==="ads")return rows.map(x=>({
      "Tài khoản QC":x.ad_account_name||"","ID tài khoản":x.ad_account_id||"",
      "Chiến dịch":x.campaign_name||"","ID chiến dịch":x.campaign_id||"",
      "Nhóm quảng cáo":x.adset_name||"","ID nhóm quảng cáo":x.adset_id||"",
      "Quảng cáo":x.ad_name||"","ID quảng cáo":x.ad_id||"","Trạng thái":x.effective_status||x.ad_status||"",
      "Đối chiếu dữ liệu":x.data_match_status||"",
      "Chi tiêu chưa VAT":+x.spend||0,"VAT":+x.tax_amount||0,"Chi tiêu có VAT":+x.spend_with_tax||0,
      "Hiển thị":+x.impressions||0,"Tiếp cận":+x.reach||0,"Click":+x.clicks||0,"Click liên kết":+x.link_clicks||0,
      "Hội thoại Meta":+x.meta_conversations||0,"Hội thoại thực":+x.conversations||0,"Có SĐT/Zalo":+x.contacts||0,
      "Tỷ lệ lấy số (%)":+x.contact_rate||0,"Khách nóng":+x.hot_leads||0,
      "Cost/Hội thoại":+x.cost_per_conversation||0,"Cost/SĐT":+x.cost_per_contact||0
    }));
    if(type==="daily")return rows.map(x=>({
      "Ngày":x.report_date||"","Page":x.page_name||"","Tài khoản QC":x.ad_account_name||"Tự nhiên / chưa xác định",
      "Trạng thái dữ liệu":x.data_status||"",
      "Chi tiêu chưa VAT":+x.spend||0,"VAT":+x.tax_amount||0,"Chi tiêu có VAT":+x.spend_with_tax||0,
      "Hội thoại":+x.conversations||0,"Có SĐT/Zalo":+x.contacts||0,"Tỷ lệ lấy số (%)":+x.contact_rate||0,
      "Khách nóng":+x.hot_leads||0,"Số tin khách":+x.message_count||0,
      "Cost/Hội thoại":+x.cost_per_conversation||0,"Cost/SĐT":+x.cost_per_contact||0
    }));
    return rows.map(x=>({
      "Ngày":x.report_date||"","Khách hàng":x.customer_name||"","ID khách":x.customer_id||x.sender_id||"",
      "Loại khách":x.customer_source_type==="comment"?"Khách comment":"Khách nhắn tin",
      "SĐT":x.phone||"","Zalo":x.zalo||"","Đã có liên hệ":x.has_contact?"Có":"Không",
      "Page":x.page_name||"","ID Page":x.page_id||"","Tài khoản QC":x.ad_account_name||"",
      "Chiến dịch":x.campaign_name||"","Nhóm quảng cáo":x.adset_name||"","Quảng cáo":x.ad_name||"",
      "Trạng thái QC":x.ad_status||x.effective_status||"","Sản phẩm":x.product_label||x.product_group||"",
      "Nguồn":sourceLabel(x),"Tag Pancake":Array.isArray(x.pancake_tags)?x.pancake_tags.map(t=>t?.text||t?.name||String(t||"")).filter(Boolean).join(", "):"",
      "Nhân viên":x.pancake_employee||"","Tin cuối":x.last_snippet||"","Số tin/bình luận":+x.message_count||0,
      "Thời gian":x.last_customer_at||x.conversation_started_at||""
    }));
  }

  app.get("/functions/v1/aiguka-v8-report-api",async(req,res)=>{
    const action=String(req.query.action||"health").toLowerCase();
    try{
      if(action==="health")return res.json({ok:true,service:"aiguka-v8-report-railway",version:3,report_source:"v10_live_reporting_unified"});
      if(action==="filters")return res.json(await rpc("v8_report_filters_test"));
      if(action==="summary"){
        const a=args(req.query);delete a.p_limit;delete a.p_offset;
        return res.json(await rpc("v8_report_summary_test",a));
      }
      if(["ads","daily","leads"].includes(action)){
        const name=action==="ads"?"v8_report_ads_test":action==="daily"?"v8_report_daily_test":"v8_report_leads_test";
        const defaultLimit=action==="leads"&&!String(req.query.limit||"").trim()?1000:null;
        return res.json(await rpc(name,args(req.query,defaultLimit)));
      }
      if(action==="system"){
        const d=await rpc("v8_admin_control_overview");
        return res.json({ok:true,data:{pages:d.pages||[],ad_accounts:d.ad_accounts||[],workers:[],server:d.health||null}});
      }
      if(action==="export"){
        const type=["ads","daily","leads"].includes(String(req.query.report))?String(req.query.report):"ads";
        const name=type==="ads"?"v8_report_ads_test":type==="daily"?"v8_report_daily_test":"v8_report_leads_test";
        const d=await rpc(name,args(req.query,10000));
        const ws=XLSX.utils.json_to_sheet(exportRows(d.data||[],type));
        const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,type);
        const buffer=XLSX.write(wb,{type:"buffer",bookType:"xlsx"});
        res.setHeader("content-type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("content-disposition",`attachment; filename="bao-cao-${type}-${req.query.from||""}_den_${req.query.to||""}.xlsx"`);
        return res.send(buffer);
      }
      res.status(404).json({ok:false,error:"unknown_route"});
    }catch(error){
      console.error("[AIGUKA report]",error);
      res.status(500).json({ok:false,error:error instanceof Error?error.message:String(error)});
    }
  });

  return {rpc};
}
