import React from 'react';

const renderInline=(text:string,keyPrefix:string):React.ReactNode[]=>{
  const parts:React.ReactNode[]=[];
  const pattern=/(\*\*[^*]+\*\*|\`[^\`]+\`|\[[^\]]+\]\([^)]+\))/g;
  let last=0;let match:RegExpExecArray|null;let index=0;
  while((match=pattern.exec(text))!==null){
    if(match.index>last)parts.push(text.slice(last,match.index));
    const token=match[0];
    if(token.startsWith('**'))parts.push(<strong key={keyPrefix+'-b-'+index} className="font-semibold text-slate-100">{token.slice(2,-2)}</strong>);
    else if(token.startsWith('`'))parts.push(<code key={keyPrefix+'-c-'+index} className="rounded bg-slate-900 px-1 py-0.5 font-mono text-[0.92em] text-cyan-300">{token.slice(1,-1)}</code>);
    else{
      const link=token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if(link){
        const href=/^https?:\/\//i.test(link[2])?link[2]:'#';
        parts.push(<a key={keyPrefix+'-a-'+index} href={href} target="_blank" rel="noreferrer" className="text-cyan-300 underline decoration-cyan-700/60 underline-offset-2 hover:text-cyan-200">{link[1]}</a>);
      }else parts.push(token);
    }
    last=match.index+token.length;index++;
  }
  if(last<text.length)parts.push(text.slice(last));
  return parts;
};

export const ChatMarkdown:React.FC<{content:string;className?:string}>=({content,className=''})=>{
  const raw=String(content||'').replace(/\r\n/g,'\n');
  const lines=raw.split('\n');
  const blocks:React.ReactNode[]=[];
  let i=0;
  while(i<lines.length){
    const line=lines[i];
    if(line.trim().startsWith('```')){
      const language=line.trim().slice(3).trim();
      const code:string[]=[];i++;
      while(i<lines.length&&!lines[i].trim().startsWith('```')){code.push(lines[i]);i++;}
      if(i<lines.length)i++;
      blocks.push(<pre key={'code-'+i} className="my-2 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-300"><code data-language={language||undefined}>{code.join('\n')}</code></pre>);
      continue;
    }
    if(!line.trim()){blocks.push(<div key={'space-'+i} className="h-1.5"/>);i++;continue;}
    const heading=line.match(/^(#{1,3})\s+(.+)$/);
    if(heading){
      const size=heading[1].length===1?'text-sm':heading[1].length===2?'text-[13px]':'text-xs';
      blocks.push(<div key={'h-'+i} className={`mt-2 ${size} font-semibold text-slate-100`}>{renderInline(heading[2],'h'+i)}</div>);i++;continue;
    }
    const bullet=line.match(/^\s*[-*•]\s+(.+)$/);
    if(bullet){blocks.push(<div key={'li-'+i} className="flex items-start gap-2"><span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-500"/><span>{renderInline(bullet[1],'li'+i)}</span></div>);i++;continue;}
    const numbered=line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if(numbered){blocks.push(<div key={'ol-'+i} className="flex items-start gap-2"><span className="min-w-4 font-mono text-[10px] text-slate-500">{numbered[1]}.</span><span>{renderInline(numbered[2],'ol'+i)}</span></div>);i++;continue;}
    blocks.push(<p key={'p-'+i} className="leading-relaxed">{renderInline(line,'p'+i)}</p>);i++;
  }
  return <div className={`space-y-1 text-[12px] leading-relaxed text-slate-300 ${className}`}>{blocks}</div>;
};
