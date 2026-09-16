from pathlib import Path

# Make preview status non-blocking. Starting/installing runtimes are observed instead of
# making the browser hold one HTTP request for up to two minutes.
p=Path('server/routes.ts'); s=p.read_text()
old="""  try {
    const runtime = await RuntimeManager.ensure(req.params.projectId);
    if (runtime.status === 'running') return res.json({ status: 'running', entryPath: '', runtime, message: `Runtime ${runtime.framework || 'framework'} ativo em ${runtime.url}.` });
    if (runtime.status === 'static') return res.status(422).json(staticInfo);
    return res.status(runtime.status === 'error' ? 422 : 202).json({ status: runtime.status === 'error' ? 'error' : 'loading', runtime, message: runtime.lastError || `Runtime ${runtime.status}.` });
  } catch (error: any) {
    res.status(422).json({ status: 'error', message: String(error?.message || error) });
  }
"""
new="""  try {
    const current = RuntimeManager.get(req.params.projectId);
    if (current?.status === 'running') return res.json({ status: 'running', entryPath: '', runtime: current, message: `Runtime ${current.framework || 'framework'} ativo.` });
    if (current?.status === 'starting' || current?.status === 'installing') return res.status(202).json({ status:'loading', runtime:current, message: current.status === 'installing' ? 'Preparando dependências do preview…' : 'Iniciando preview…' });
    if (current?.status === 'error') return res.status(422).json({ status:'error', runtime:current, message:current.lastError || 'O runtime do preview falhou.' });
    void RuntimeManager.ensure(req.params.projectId).catch(()=>undefined);
    return res.status(202).json({ status:'loading', message:'Preparando runtime isolado do preview…' });
  } catch (error: any) {
    res.status(422).json({ status: 'error', message: String(error?.message || error) });
  }
"""
if old not in s: raise SystemExit('preview status block not found')
s=s.replace(old,new,1); p.write_text(s)

# Poll while the backend is preparing the runtime, and make Refresh perform a real
# runtime rebuild instead of only refreshing the iframe.
p=Path('src/components/WorkspaceArea.tsx'); s=p.read_text()
needle="""  useEffect(() => {
    loadPreviewInfo();
  }, [project?.id, previewNonce, previewProposalId]);
"""
replacement=needle+"""
  useEffect(() => {
    if (!project || previewProposalId || previewInfo.status !== 'loading') return;
    const timer = window.setTimeout(() => { void loadPreviewInfo(); }, 1500);
    return () => window.clearTimeout(timer);
  }, [project?.id, previewProposalId, previewInfo.status, previewInfo.message]);

  const rebuildPreview = async () => {
    if (!project) return;
    setPreviewInfo({status:'loading',message:'Recriando o runtime do preview…'});
    try {
      const response=await fetch(`/api/projects/${project.id}/preview/rebuild`,{method:'POST'});
      const data=await response.json();
      if(!response.ok)throw new Error(data.message||data.error||'Não foi possível recriar o preview.');
      setPreviewInfo(data);
      setPreviewKey(Date.now());
    }catch(error:any){setPreviewInfo({status:'error',message:error.message});}
  };
"""
if needle not in s: raise SystemExit('preview effect not found')
s=s.replace(needle,replacement,1)
s=s.replace("onClick={() => setPreviewKey(Date.now())}\n                title=\"Recarregar Preview\"","onClick={() => { void rebuildPreview(); }}\n                title=\"Recriar Preview\"",1)
p.write_text(s)
