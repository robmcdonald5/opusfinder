/**
 * Inlined into every page: the CSP allows inline styles and SVG only, so fonts are the system stack.
 * Each color means one thing: green on/ok, violet "logs only", amber needs a look, red went
 * wrong, grey off/closed, blue links, buttons and information.
 */

export const STYLE = `
:root{color-scheme:light dark;--canvas:#fafafa;--surface:#fff;--raised:#fafafa;--tint:#f5f5f5;--line:#e5e5e5;--hair:#efefef;--fg:#171717;--strong:#0a0a0a;--muted:#6b6b6b;--brand:#f6821f;--blue:#2f62e6;--blue-h:#1447e6;--link:#1447e6;--ok:#047857;--ok-bg:#dcfce7;--warn:#8a5300;--warn-bg:#fef3c7;--bad:#c10007;--bad-bg:#fee2e2;--dry:#6d28d9;--info-bg:#e8f0fe;--meter:#2f62e6;--meter-bg:#dbe4fd;--meter-warn:#b45309;--meter-warn-bg:#fdecc8;--meter-bad:#c10007;--meter-bad-bg:#fde0e0}
@media (prefers-color-scheme:dark){:root{--canvas:#0a0a0a;--surface:#141414;--raised:#191919;--tint:#232323;--line:#2b2b2b;--hair:#222;--fg:#e5e5e5;--strong:#fafafa;--muted:#a1a1a1;--blue:#3b6cf5;--blue-h:#5a85ff;--link:#7aa7ff;--ok:#4ade80;--ok-bg:rgba(34,197,94,.14);--warn:#fbbf24;--warn-bg:rgba(245,158,11,.14);--bad:#f87171;--bad-bg:rgba(239,68,68,.15);--dry:#c4b5fd;--info-bg:rgba(59,108,245,.14);--meter:#5a85ff;--meter-bg:rgba(59,108,245,.22);--meter-warn:#f59e0b;--meter-warn-bg:rgba(245,158,11,.2);--meter-bad:#f87171;--meter-bad-bg:rgba(239,68,68,.22)}}
*{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
a:focus-visible,button:focus-visible,summary:focus-visible,input:focus,select:focus{outline:2px solid var(--blue);outline-offset:1px}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
p{margin:0}
.app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;background:var(--surface);border-right:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;height:56px;padding:0 16px;border-bottom:1px solid var(--line);color:var(--strong);font-weight:600}
.brand:hover{text-decoration:none}
.mark{width:14px;height:14px;border-radius:4px;background:var(--brand)}
.brand span{color:var(--muted);font-weight:500}
.nav{flex:1;display:flex;flex-direction:column;gap:1px;padding:12px 8px;overflow-y:auto}
.nav a{display:flex;align-items:center;gap:10px;min-height:34px;padding:0 10px;border-radius:6px;color:var(--fg);font-weight:500;white-space:nowrap}
.nav a:hover{background:var(--tint);text-decoration:none}
.nav a[aria-current=page]{background:var(--tint);color:var(--strong);font-weight:600}
.nav svg{width:16px;height:16px;flex:none;color:var(--muted)}
.nav a[aria-current=page] svg{color:var(--strong)}
.count{margin-left:auto;padding:0 7px;border-radius:999px;background:var(--warn-bg);color:var(--warn);font-size:12px;font-weight:600}
.who{display:grid;gap:2px;padding:12px 16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
.who .id{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--fg)}
.main{min-width:0;max-width:1100px;padding:28px 32px 48px}
.head{margin-bottom:20px}
.tabs{display:flex;gap:4px;margin:-6px 0 16px;border-bottom:1px solid var(--line)}
.tabs a{margin-bottom:-1px;padding:8px 12px;border-bottom:2px solid transparent;color:var(--muted);font-weight:500}
.tabs a:hover{color:var(--fg);text-decoration:none}
.tabs a[aria-current=page]{border-bottom-color:var(--blue);color:var(--strong);font-weight:600}
h1{margin:0;font-size:24px;line-height:1.25;font-weight:600;color:var(--strong)}
.card{margin:0 0 16px;background:var(--surface);border:1px solid var(--line);border-radius:8px}
.card-h{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px;padding:12px 16px;border-bottom:1px solid var(--line)}
.card-h h2{margin:0;font-size:14px;font-weight:600;color:var(--strong)}
.card-b{padding:16px;overflow-wrap:break-word}
.card-b>*+*{margin-top:12px}
.card-f{padding:10px 16px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
details.fold>summary{cursor:pointer;list-style:none}
details.fold>summary::-webkit-details-marker{display:none}
details.fold:not([open])>summary{border-bottom:0}
details.fold>summary h2::before{content:"";display:inline-block;width:6px;height:6px;margin:0 10px 2px 1px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(-45deg);transition:transform .15s}
details.fold[open]>summary h2::before{transform:rotate(45deg)}
details.fold>summary:hover h2{color:var(--link)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{padding:10px 16px;text-align:left;vertical-align:top}
th{background:var(--raised);border-bottom:1px solid var(--line);color:var(--muted);font-size:12px;font-weight:600;white-space:nowrap}
td{border-bottom:1px solid var(--hair);white-space:nowrap}
td.fill{width:100%;max-width:0;white-space:normal}
tr:last-child>td{border-bottom:0}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.nowrap{white-space:nowrap}
.rows{margin:0;padding:0;list-style:none}
.rows>li{padding:12px 16px;border-bottom:1px solid var(--hair)}
.rows>li:last-child{border-bottom:0}
.rows .rows{margin-top:10px}
.rows .rows>li,.card-b .rows>li{padding:10px 0;border-bottom:0;border-top:1px solid var(--hair)}
.rows .rows>li:last-child{padding-bottom:0}
.item>.nest{grid-column:1/-1;grid-row:5;margin-left:16px}
.rows.nest{margin-top:4px}
.rows.nest>li{padding:4px 0;border-top:0}
.nest strong{font-weight:400}
.item{display:grid;grid-template-columns:minmax(0,1fr) auto auto;grid-template-areas:"t end act" "sub end act";align-items:center;column-gap:16px}
.item.solo{grid-template-areas:"t end act"}
.item.noact{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"t end" "sub end"}
.item.noact.solo{grid-template-areas:"t end"}
.item.ctl:not(.solo){grid-template-columns:minmax(0,16rem) minmax(0,1fr) auto;grid-template-areas:"t sub end"}
.item.ctl>.sub,.item.ctl>.sub>.m{margin-top:0}
.item.idle .t{color:var(--muted)}
.item>.t{grid-area:t;min-width:0}
.item>.sub{grid-area:sub;min-width:0}
.item>.end{grid-area:end;display:flex;align-items:center;justify-content:flex-end;gap:8px;white-space:nowrap}
.item>.act{grid-area:act}
.item>.act>details.change{margin:0}
.item>.panel{grid-column:1/-1;grid-row:3;display:none}
.item:has(>.act>details[open])>.panel{display:flex;flex-wrap:wrap;align-items:stretch;gap:12px;padding-top:12px}
.item>.panel>.form{flex:1 1 300px;margin-top:0}
.item>.panel>.form.two{flex-basis:520px}
.item .t,.item .b,.item .m{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.item .b,.item .m{margin-top:2px}
.item .m{color:var(--muted);font-size:13px}
details.clip>summary{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;list-style:none}
details.clip>summary::-webkit-details-marker{display:none}
details.clip[open]>summary{white-space:normal;overflow-wrap:anywhere}
.sub{margin-top:2px;color:var(--muted);font-size:13px}
.muted{color:var(--muted)}
.rows>.grp{display:flex;align-items:center;gap:10px;padding:7px 16px;background:var(--raised);border-bottom:1px solid var(--hair);color:var(--muted);font-size:12px;font-weight:600}
.rows>.item+.grp{border-top:1px solid var(--hair)}
.rows:has(>.grp)>.item{border-bottom:0}
.grp a{color:inherit}
.grp .mode{font-weight:500}
.warn{color:var(--warn);font-weight:500}
.bad{color:var(--bad);font-weight:500}
.empty{padding:20px 16px;color:var(--muted);text-align:center}
.mode{white-space:nowrap}
.mode::before{content:"";display:inline-block;width:7px;height:7px;margin-right:6px;border-radius:50%;background:var(--muted);vertical-align:1px}
.m-on::before,.m-enforce::before,.m-approved::before,.m-ok::before,.m-recorded::before,.w-enforced::before{background:var(--ok)}
.m-shadow::before,.w-shadow::before{background:var(--dry)}
.m-inherit::before{background:none;box-shadow:inset 0 0 0 1.5px var(--muted)}
.m-stale::before,.m-partial::before,.m-review::before{background:var(--warn)}
.m-bad::before,.m-error::before{background:var(--bad)}
.banner{margin:0 0 16px;padding:10px 14px;border-radius:8px;border-left:3px solid var(--blue);background:var(--info-bg)}
.banner.ok{border-left-color:var(--ok);background:var(--ok-bg)}
.banner.warn{border-left-color:var(--warn);background:var(--warn-bg)}
.banner.bad{border-left-color:var(--bad);background:var(--bad-bg)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin:0 0 16px}
.stat{display:flex;flex-direction:column;gap:4px;min-width:0;padding:16px;background:var(--surface);border:1px solid var(--line);border-radius:8px;color:var(--fg)}
a.stat:hover{border-color:var(--muted);text-decoration:none}
.stat .l{color:var(--muted);font-size:13px;font-weight:500}
.stat .v{color:var(--strong);font-size:24px;font-weight:600;line-height:1.25}
.stat .v.bad{color:var(--bad)}
.stat .v.warn{color:var(--warn)}
.meter{display:block;height:6px;margin:2px 0;border-radius:3px;background:var(--meter-bg);overflow:hidden}
.meter>span{display:block;height:100%;border-radius:3px;background:var(--meter)}
.meter.warn{background:var(--meter-warn-bg)}
.meter.warn>span{background:var(--meter-warn)}
.meter.bad{background:var(--meter-bad-bg)}
.meter.bad>span{background:var(--meter-bad)}
.stat .s{margin-top:auto;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--muted);font-size:13px}
dl.kv{display:grid;grid-template-columns:minmax(110px,max-content) minmax(0,1fr);gap:10px 24px;margin:0}
dl.kv dt{color:var(--muted)}
dl.kv dd{margin:0;min-width:0}
.dot{display:inline-block;width:8px;height:8px;margin-right:8px;border-radius:50%;background:var(--warn)}
.dot.bad{background:var(--bad)}
.good{color:var(--ok)}
.good svg{width:16px;height:16px;margin-right:6px;vertical-align:-3px}
tr.err>td:first-child{box-shadow:inset 3px 0 var(--bad)}
details.change>summary,details.more>summary{display:inline-flex;align-items:center;height:28px;padding:0 10px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--fg);font-size:13px;font-weight:500;cursor:pointer;list-style:none;white-space:nowrap}
details.change>summary::-webkit-details-marker,details.more>summary::-webkit-details-marker{display:none}
details.change>summary:hover,details[open].change>summary{background:var(--tint)}
details.more>summary{border:0;padding:0;height:auto;background:none;color:var(--link)}
.form{display:flex;flex-direction:column;gap:10px;max-width:480px;margin-top:10px;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--raised)}
.form>.actions{margin-top:auto}
.form.two{display:grid;grid-template-columns:1fr 1fr;align-content:start;max-width:640px}
.form.two>.full,.form.two>.actions{grid-column:1/-1}
label{display:grid;align-content:start;gap:4px;color:var(--muted);font-size:13px;font-weight:500}
input,select{width:100%;height:36px;padding:0 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--fg);font:inherit}
button{display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--fg);font:inherit;font-weight:500;cursor:pointer}
button:hover{background:var(--tint)}
button.primary{background:var(--blue);border-color:var(--blue);color:#fff}
button.primary:hover{background:var(--blue-h);border-color:var(--blue-h)}
button.danger{color:var(--bad)}
.actions{display:flex;flex-wrap:wrap;gap:8px}
.sw{display:inline-flex;flex-direction:row-reverse;align-items:center;gap:6px;margin:0;vertical-align:middle}
.sw>.go{display:none;height:28px;padding:0 10px;border-radius:6px;font-size:13px}
.sw:has(option:checked:not([selected]),input[type=number]:not(:placeholder-shown))>.go{display:inline-flex}
.sw select,.sw input{width:auto;height:28px;border-radius:6px;background-color:transparent}
.sw select:hover,.sw .field:hover,.sw:has(.go:hover) :is(select,.field){background-color:var(--tint)}
.sw select{border-color:transparent;cursor:pointer;appearance:none;-webkit-appearance:none;field-sizing:content;padding:0 22px 0 20px;background-image:radial-gradient(circle,var(--dot,var(--muted)) 3.5px,transparent 4px),linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:6px 50%,calc(100% - 13px) 55%,calc(100% - 9px) 55%;background-size:9px 9px,4px 4px,4px 4px;background-repeat:no-repeat}
.sw select:has(option[value=on]:checked),.sw select:has(option[value=enforce]:checked){--dot:var(--ok)}
.sw select:has(option[value=shadow]:checked){--dot:var(--dry)}
.sw select:has(option[value=inherit]:checked){background-image:radial-gradient(circle,transparent 2.2px,var(--muted) 2.7px 3.5px,transparent 4px),linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%)}
.sw .field{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:1px solid var(--line);border-radius:6px;color:var(--fg);font-size:14px;font-weight:400}
.sw .field>span{color:var(--muted)}
.sw .field:focus-within{border-color:var(--blue)}
.sw input{height:26px;padding:0;border:0;border-radius:0;text-align:right;-moz-appearance:textfield}
.sw input:focus{outline:0}
.sw input::placeholder{color:var(--fg);opacity:1}
@supports (field-sizing:content){.sw input{field-sizing:content;width:auto!important;min-width:2ch}}
.sw input::-webkit-inner-spin-button,.sw input::-webkit-outer-spin-button{margin:0;-webkit-appearance:none}
.filters{display:flex;flex-wrap:wrap;align-items:end;gap:8px;margin:0 0 16px}
.filters label{min-width:160px}
@media (max-width:760px){
.app{display:block}
.side{position:static;height:auto;display:grid;grid-template-columns:auto 1fr;border-right:0;border-bottom:1px solid var(--line)}
.brand{height:48px;border-bottom:0}
.who{grid-row:1;grid-column:2;display:block;align-self:center;padding:0 16px;border:0;text-align:right}
.who .id,.who .ro{display:none}
.form.two{grid-template-columns:1fr}
.item,.item.solo{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"t end" "sub sub" "act act"}
.item.noact,.item.noact.solo{grid-template-areas:"t end" "sub sub"}
.item>.act{justify-self:start;margin-top:8px}
.item>.panel{grid-row:4}
.item.ctl:not(.solo){grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"t end" "sub sub"}
.item.ctl>.sub{margin-top:2px}
.item:has(>.end>.sw:not(:last-child),>.end>.sw option:checked:not([selected]),>.end>.sw input[type=number]:not(:placeholder-shown)){grid-template-columns:minmax(0,1fr);grid-template-areas:"t" "sub" "end"}
.item:has(>.end>.sw:not(:last-child),>.end>.sw option:checked:not([selected]),>.end>.sw input[type=number]:not(:placeholder-shown))>.end{justify-content:flex-start;margin-top:8px;white-space:normal}
.sw{flex-direction:row}
.nav{grid-column:1/-1;flex-direction:row;flex-wrap:wrap;gap:2px;padding:0 8px 8px;overflow:visible}
.nav a{min-height:30px;padding:0 8px}
.nav svg{display:none}
.main{padding:20px 16px 40px}
.stats{grid-template-columns:1fr 1fr;gap:12px}
.stat{padding:12px}
.stat .v{font-size:20px}
dl.kv{grid-template-columns:1fr;gap:0}
dl.kv dd{margin-bottom:10px}
table.stack,table.stack tbody{display:block;width:100%}
table.stack thead{display:none}
table.stack tr{display:block;padding:10px 16px;border-bottom:1px solid var(--hair)}
table.stack tr.err{box-shadow:inset 3px 0 var(--bad)}
table.stack tr.err>td:first-child{box-shadow:none}
table.stack tr:last-child{border-bottom:0}
table.stack td{display:inline-block;padding:0 12px 2px 0;border:0;text-align:left}
table.stack td:last-child,table.stack td.fill{display:block;width:auto;max-width:100%;overflow:hidden}
table.labelled td,table.labelled td:last-child{display:inline-flex;align-items:center;gap:6px;padding:2px 14px 2px 0}
table.labelled td::before{content:attr(data-label);color:var(--muted);font-size:12px}
table.labelled td:first-child{display:block}
table.labelled td:first-child::before{content:none}
}
`;
