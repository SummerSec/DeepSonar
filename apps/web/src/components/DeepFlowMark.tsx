type DeepFlowMarkProps = {
  className?: string;
};

export function DeepFlowMark({ className }: DeepFlowMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M7 5.5h6.5C22 5.5 27 9.5 27 16s-5 10.5-13.5 10.5H7" />
      <path d="M7 5.5v8.25h5M7 26.5v-8.25h5" />
      <circle cx="7" cy="5.5" r="2.25" />
      <circle cx="27" cy="16" r="2.25" />
      <circle cx="7" cy="26.5" r="2.25" />
      <path d="m12 11.75 7 4.25-7 4.25Z" className="deep-flow-mark__arrow" />
      <circle cx="22.5" cy="16" r="1.75" className="deep-flow-mark__core" />
    </svg>
  );
}
