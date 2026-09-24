"use client";

import {
  useDropzone,
  type DropzoneOptions,
  type DropzoneState,
} from "react-dropzone";
type Props = DropzoneOptions & {
  children: (s: DropzoneState) => React.ReactNode;
};
export default function Dropzone({ children, ...opts }: Props) {
  const dz = useDropzone(opts);
  return (
    <div {...dz.getRootProps()}>
      {children(dz)}
      <input {...dz.getInputProps()} />
    </div>
  );
}
export type { DropzoneState };
