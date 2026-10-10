import type { HTMLAttributes, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';

export function TableContainer({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`table-container ${className}`.trim()} {...rest} />;
}

export function Table({ className = '', ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={`data-table ${className}`.trim()} {...rest} />;
}

export function THead({ ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...rest} />;
}

export function TBody({ ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...rest} />;
}

export function TR({ ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr {...rest} />;
}

export function TH({ ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" {...rest} />;
}

export function TD({ ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...rest} />;
}
