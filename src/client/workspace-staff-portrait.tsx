import { useId, useLayoutEffect, useRef, useState } from 'react'
import { avatarColors, avatarShapes, defaultStaffPortrait, type AvatarShape, type AvatarColor, type SpeakerPortrait } from '../core/workspace-avatars.ts'
import type { StaffMember } from '../core/workspace-staff.ts'
import { ChatAvatar } from './workspace-chat-avatar.tsx'
import { animatePortrait } from './workspace-avatar-motion.ts'
import { Issue, V2Dialog } from './workspace-v2-elements.tsx'

const shapeNames:Record<AvatarShape,string> = {
  plane:'纸飞机', sprout:'双叶书签', wrench:'短柄扳手', compass:'指南针', pencil:'铅笔',
  lighthouse:'灯塔', bell:'铃铛', fan:'折扇', key:'钥匙', hourglass:'沙漏',
}
const colorNames:Record<AvatarColor,string> = {
  blue:'钴蓝', mint:'薄荷', apricot:'杏橙', violet:'鸢紫', rose:'莓红', teal:'湖青', honey:'蜜黄',
}

interface Props {
  member:StaffMember
  busy:boolean
  error?:string
  close:()=>void
  save:(portrait:SpeakerPortrait|null)=>void
}

export function StaffPortraitPicker({member,busy,error,close,save}:Props) {
  const group = useId()
  const [selection,setSelection] = useState<SpeakerPortrait|null>(member.portrait ?? null)
  const current = selection ?? member.defaultPortrait ?? defaultStaffPortrait(member.id)
  const {shape,color} = current
  const [playback,replay] = useState(0)
  const preview = useRef<HTMLDivElement>(null)
  useLayoutEffect(()=>{
    if (!playback) return
    const svg = preview.current?.querySelector('svg')
    const animation = svg && animatePortrait(svg,shape)
    return ()=>animation?.cancel()
  },[playback,shape,color])
  function choose(portrait:SpeakerPortrait|null) {setSelection(portrait); replay(n=>n+1)}
  return <V2Dialog title="更换头像" meta={member.name} close={close}>
    <form className="v2-staff-portrait-form" onSubmit={e=>{e.preventDefault();save(selection)}}>
      <div className="v2-portrait-preview" ref={preview} data-portrait-preview="">
        <ChatAvatar portrait={current}/>
        <div><strong>{shapeNames[shape]+' · '+colorNames[color]}</strong>
          <button type="button" className="v2-link" onClick={()=>replay(n=>n+1)}>预览动效</button></div>
      </div>
      <fieldset disabled={busy}><legend>选择物件</legend><div className="v2-portrait-choices">
        {avatarShapes.map(shape=><label key={shape}>
          <input type="radio" name={group+'-shape'} checked={current.shape === shape} onChange={()=>choose({shape,color:current.color})}/>
          <ChatAvatar portrait={{shape,color:current.color}}/><span>{shapeNames[shape]}</span>
        </label>)}
      </div></fieldset>
      <fieldset disabled={busy}><legend>选择配色</legend><div className="v2-portrait-choices colors">
        {avatarColors.map(color=><label key={color}>
          <input type="radio" name={group+'-color'} checked={current.color === color} onChange={()=>choose({shape:current.shape,color})}/>
          <ChatAvatar portrait={{shape:current.shape,color}}/><span>{colorNames[color]}</span>
        </label>)}
      </div></fieldset>
      <Issue text={error}/>
      <div className="v2-actions"><button type="submit" className="v2-button primary" disabled={busy}>保存头像</button>
        <button type="button" className="v2-button" onClick={close} disabled={busy}>取消</button>
        <button type="button" className="v2-link" onClick={()=>choose(null)} disabled={busy}>恢复默认头像</button></div>
    </form>
  </V2Dialog>
}
