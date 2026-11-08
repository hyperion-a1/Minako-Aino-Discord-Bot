import { useEffect } from 'react';

// Efeito visual: faíscas ao clicar em botões, links e interruptores. Respeita "reduzir movimento".
export default function Fx() {
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const onClick = (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('button,a,.dash-toggle')) return;
      for (let i = 0; i < 7; i += 1) {
        const spark = document.createElement('span');
        spark.className = 'fx-spark';
        spark.textContent = i % 2 ? '✦' : '✧';
        const angle = (Math.PI * 2 * i) / 7 + Math.random() * 0.6;
        const dist = 28 + Math.random() * 26;
        spark.style.cssText = `left:${e.clientX}px;top:${e.clientY}px;--dx:${Math.cos(angle) * dist}px;--dy:${Math.sin(angle) * dist}px`;
        document.body.appendChild(spark);
        setTimeout(() => spark.remove(), 700);
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  return null;
}
