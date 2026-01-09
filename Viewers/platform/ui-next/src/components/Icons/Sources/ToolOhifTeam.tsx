import React from 'react';
import type { IconProps } from '../types';

export const ToolOhifTeam = (props: IconProps) => (
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
    <g stroke="currentColor" strokeWidth="8" fill="none">
      <rect x="5" y="5" width="40" height="40" rx="10" ry="10"/>
      <rect x="55" y="5" width="40" height="40" rx="10" ry="10"/>
      <rect x="5" y="55" width="40" height="40" rx="10" ry="10"/>
      <rect x="55" y="55" width="40" height="40" rx="10" ry="10"/>
    </g>
  </svg>
);

export default ToolOhifTeam;
