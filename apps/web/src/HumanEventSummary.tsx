export function HumanEventSummary({ text }: { text: string }) {
  return (
    <details>
      <summary>查看请求摘要（未经核验）</summary>
      <blockquote className="whitespace-pre-wrap break-words">{text}</blockquote>
    </details>
  );
}
