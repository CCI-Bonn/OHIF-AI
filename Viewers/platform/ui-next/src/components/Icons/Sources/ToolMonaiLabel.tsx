import React from 'react';
import type { IconProps } from '../types';

export const ToolMonaiLabel = (props: IconProps) => (
  <svg
    version="1.0"
    xmlns="http://www.w3.org/2000/svg"
    className="w-[24px] h-[24px] fill-current"
    width="24"
    height="24"
    viewBox="0 0 100 100"
    preserveAspectRatio="xMidYMid meet"
    {...props}
  >
    <g stroke="currentColor" strokeWidth="2" fill="none">
      <path d="M30,10 L70,10 L90,30 L90,70 L70,90 L30,90 L10,70 L10,30 Z" strokeWidth="5"/>
      <path d="M50,20 L29,29 L20,50 L29,71 L50,80 L71,71 L80,50 L71,29 Z" strokeWidth="1"/>
      <path d="M50,20 L50,80 M20,50 L80,50 M29,29 L71,71 M71,29 L29,71" strokeWidth="1"/>
      <circle cx="50" cy="20" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="71" cy="29" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="80" cy="50" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="71" cy="71" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="50" cy="80" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="29" cy="71" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="20" cy="50" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="29" cy="29" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="50" cy="50" r="1.5" fill="currentColor" stroke="none"/>
    </g>
  </svg>
);

export default ToolMonaiLabel;
