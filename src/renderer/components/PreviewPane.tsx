import { useCallback } from 'react'
import type React from 'react'
import type { YesChefApi } from '../../shared/ipc.js'
import type { PreviewSource } from '../previews.js'
import { resolveImageSrc } from '../../shared/preview.js'
import { usePreviewRead } from '../hooks/usePreviewRead.js'
import { DocumentPreview } from './DocumentPreview.js'
import './PreviewPane.css'

export interface PreviewPaneProps {
  readonly api: Pick<YesChefApi, 'readPreview'>
  readonly source: Exclude<PreviewSource, { kind: 'diff' }>
}

interface ProjectImageProps {
  readonly api: Pick<YesChefApi, 'readPreview'>
  readonly projectId: string
  readonly path: string
  readonly alt: string
}

function ProjectImage({ api, projectId, path, alt }: ProjectImageProps): React.ReactElement {
  const { loaded, retry } = usePreviewRead(api, projectId, path)
  if (loaded.kind === 'loading') return <span>{alt || '圖片'}</span>
  if (loaded.kind === 'image') return <img src={`data:${loaded.mimeType};base64,${loaded.dataBase64}`} alt={alt} />
  return <span>{`(圖片讀取失敗:${loaded.kind === 'rejected' ? loaded.message : '不是圖片'})`}
    {loaded.kind === 'rejected' && <button type="button" onClick={retry}>重試</button>}
  </span>
}

export function PreviewPane({ api, source }: PreviewPaneProps): React.ReactElement {
  const projectId = source.kind === 'file' ? source.projectId : undefined
  const path = source.kind === 'file' ? source.path : undefined

  const { loaded, retry } = usePreviewRead(api, projectId, path)

  const renderImage = useCallback((src: string, alt: string) => {
    if (projectId === undefined || path === undefined) return <img src={src} alt={alt} />
    const resolved = resolveImageSrc(path, src)
    return resolved === undefined ? <img src={src} alt={alt} /> :
      <ProjectImage key={`${projectId}:${resolved}`} api={api} projectId={projectId} path={resolved} alt={alt} />
  }, [api, projectId, path])

  if (source.kind === 'image') return <div className="preview-pane"><img src={source.dataUrl} alt="截圖" /></div>
  if (loaded.kind === 'loading') return <div className="preview-pane preview-status">讀取中…</div>
  if (loaded.kind === 'rejected') return <div className="preview-pane preview-status">{loaded.message}
    <button type="button" onClick={retry}>重試</button>
  </div>
  if (loaded.kind === 'image') {
    return <div className="preview-pane"><img src={`data:${loaded.mimeType};base64,${loaded.dataBase64}`} alt={path ?? ''} /></div>
  }
  return <DocumentPreview key={`${projectId}:${path}`} text={loaded.text} renderImage={renderImage}
    path={source.path} projectId={source.projectId} location={source.location} refresh={retry} />
}
