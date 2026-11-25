import type { LiaisonToolStatus } from '../dsh/liaison.ts'

export function SettingsDiagnostics({ tools, className }: { tools: LiaisonToolStatus; className?: string }) {
  return <details className={className}>
    <summary>接口人工具诊断</summary>
    <p>执行工具检查{tools.guardInstalled ? '已启用' : '未启用'}。请求观测{tools.requestAudit === 'available' ? '已启用' : '不可用'}。</p>
    <p className="meta">这里显示模型适配器收到的工具名。发送到模型服务时，适配器还可能从历史记录补回工具声明。</p>
    {tools.sessions.length === 0 && <p>还没有可检查的接口人会话。</p>}
    {tools.sessions.map(segment => <details key={segment.sessionId}>
      <summary>{segment.sessionId}</summary>
      <p>已设置全局工具屏蔽规则（{segment.maskedGlobal.length}） {segment.maskedGlobal.join('、')}</p>
      {segment.maskFailed.length > 0 && <p>设置失败的规则 {segment.maskFailed.join('、')}</p>}
      <p>会话注册表中仍可见的禁用工具 {segment.registeredDenied?.join('、') || (segment.registeredDenied ? '无' : '无法读取')}</p>
      <p>最近一次请求中的禁用工具 {segment.requestDenied?.join('、') || (segment.requestDenied ? '无' : '尚无请求记录')}</p>
      <p>请求历史中的禁用工具 {segment.historyDenied?.join('、') || (segment.historyDenied ? '无' : '尚无请求记录')}</p>
    </details>)}
  </details>
}
