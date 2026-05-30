export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g stroke="#E8884C" strokeWidth="2.4" strokeLinecap="round">
        <path d="M24 6 V42" />
        <path d="M8.4 15 L39.6 33" />
        <path d="M8.4 33 L39.6 15" />
        <path d="M24 6 l-4 6 m4 -6 l4 6" />
        <path d="M24 42 l-4 -6 m4 6 l4 -6" />
      </g>
      <g stroke="#86BEDF" strokeWidth="2" strokeLinecap="round" opacity="0.9">
        <path d="M8.4 15 l1.5 6.8 M8.4 15 l6.8 1.6" />
        <path d="M39.6 33 l-1.5 -6.8 M39.6 33 l-6.8 -1.6" />
        <path d="M39.6 15 l-6.8 1.6 M39.6 15 l-1.5 6.8" />
        <path d="M8.4 33 l6.8 -1.6 M8.4 33 l1.5 -6.8" />
      </g>
    </svg>
  );
}
