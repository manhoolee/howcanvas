function g(){let e=globalThis.InfiniteCanvasRuntime;if(!e)throw new Error("[plugin-sdk] HowCanvas \u8FD0\u884C\u65F6\u672A\u5C31\u7EEA:\u8BF7\u5728\u753B\u5E03\u5BBF\u4E3B\u4E2D\u52A0\u8F7D\u672C\u63D2\u4EF6");return e}function r(){return g().React}var p=((...e)=>r().useState(...e)),c=((...e)=>r().useEffect(...e));var d=((...e)=>r().useRef(...e));var k=`.cnv-md {\r
    height: 100%;\r
    width: 100%;\r
    overflow: auto;\r
    padding: 16px;\r
    font-size: 14px;\r
    line-height: 1.6;\r
}\r
.cnv-md h1,\r
.cnv-md h2,\r
.cnv-md h3 {\r
    margin: 0.6em 0 0.3em;\r
    font-weight: 600;\r
    line-height: 1.3;\r
}\r
.cnv-md h1 {\r
    font-size: 1.5em;\r
}\r
.cnv-md h2 {\r
    font-size: 1.3em;\r
}\r
.cnv-md p {\r
    margin: 0.5em 0;\r
}\r
.cnv-md a {\r
    color: #6366f1;\r
    text-decoration: underline;\r
}\r
.cnv-md code {\r
    padding: 0.1em 0.35em;\r
    border-radius: 4px;\r
    background: rgba(120, 120, 120, 0.16);\r
    font-family: monospace;\r
    font-size: 0.9em;\r
}\r
.cnv-md pre {\r
    padding: 12px;\r
    border-radius: 8px;\r
    background: rgba(120, 120, 120, 0.14);\r
    overflow: auto;\r
}\r
.cnv-md pre code {\r
    padding: 0;\r
    background: transparent;\r
}\r
.cnv-md ul,\r
.cnv-md ol {\r
    padding-left: 1.4em;\r
    margin: 0.5em 0;\r
}\r
.cnv-md blockquote {\r
    margin: 0.5em 0;\r
    padding-left: 0.8em;\r
    border-left: 3px solid rgba(120, 120, 120, 0.4);\r
    opacity: 0.85;\r
}\r
.cnv-md img {\r
    max-width: 100%;\r
}\r
`;var x=Symbol.for("infinite-canvas.jsx.fragment");function C(e,n,t){let s=r(),l=e===x?s.Fragment:e,a=t===void 0?n:{...n??{},key:t};return s.createElement(l,a)}function u(e,n,t){return C(e,n,t)}var i,m,R=e=>e;function P(){return i?Promise.resolve(i):(m||(m=import("https://esm.sh/marked@14").then(e=>i=e.marked)),m)}var h="*\u9009\u4E2D\u8282\u70B9,\u70B9\u4E0A\u65B9\u5DE5\u5177\u6761\u7684 \u270E \u7F16\u8F91 Markdown*",f=new Map;function b(e){if(!i)return"";let n=e||h,t=f.get(n);return t===void 0&&(t=R(i.parse(n)),f.set(n,t)),t}function E({ctx:e}){let[,n]=p(0),t=d(null),s=d(null);c(()=>{if(i)return;let o=!0;return P().then(()=>o&&n(w=>w+1)),()=>{o=!1}},[]);let l=e.node.metadata?.content||"",a=b(l);return c(()=>{let o=t.current;!o||s.current===a||(o.innerHTML=a,s.current=a)},[a]),u("div",{ref:t,className:"cnv-md","data-canvas-no-zoom":!0,onWheel:o=>o.stopPropagation(),style:{height:"100%",width:"100%",color:e.theme.node.text}})}function M({ctx:e}){let n=e.node.metadata?.content||"";return u("textarea",{autoFocus:!0,value:n,placeholder:"# \u8F93\u5165 Markdown",onChange:t=>e.updateMetadata({content:t.target.value}),onMouseDown:t=>t.stopPropagation(),onPointerDown:t=>t.stopPropagation(),onWheel:t=>t.stopPropagation(),style:{height:"100%",width:"100%",resize:"none",background:e.theme.node.fill,borderRadius:16,boxSizing:"border-box",padding:16,fontFamily:"monospace",fontSize:14,outline:"none",border:"none",color:e.theme.node.text}})}function S({ctx:e}){return e.node.metadata?.editing?u(M,{ctx:e}):u(E,{ctx:e})}var I={id:"markdown",name:"Markdown \u8282\u70B9",version:"1.2.0",description:"\u5728\u753B\u5E03\u4E2D\u7F16\u8F91\u4E0E\u6E32\u67D3 Markdown",css:k,nodes:[{type:"markdown:doc",title:"Markdown",icon:"\u{1F4DD}",description:"\u7F16\u8F91\u4E0E\u6E32\u67D3 Markdown",defaultSize:{width:360,height:300},defaultMetadata:{content:""},minimapColor:"#6366f1",hidePanel:!0,interactionToggle:!0,forceInteractive:e=>!!e.metadata?.editing,resource:e=>({kind:"text",text:e.metadata?.content}),Content:S,toolbar:e=>{let n=!!e.node.metadata?.editing;return[{id:"md-toggle-edit",title:n?"\u9884\u89C8\u6E32\u67D3\u7ED3\u679C":"\u7F16\u8F91 Markdown \u6E90\u7801",label:n?"\u9884\u89C8":"\u7F16\u8F91",icon:n?"\u{1F441}":"\u270E",active:n,onClick:()=>e.updateMetadata({editing:!n})}]}}]},Q=e=>(R=n=>e.sanitizeHTML(n,"html"),f.clear(),I);export{Q as default};
