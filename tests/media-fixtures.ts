export const SVG=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#2864dc"/><text x="20" y="55" fill="white">Pictether SVG</text></svg>');
export function makePdf():Buffer{
  const content='BT /F1 20 Tf 36 120 Td (Pictether PDF test) Tj ET';
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let output='%PDF-1.4\n',offsets=[0];
  for(let index=0;index<objects.length;index++){offsets.push(Buffer.byteLength(output));output+=`${index+1} 0 obj\n${objects[index]}\nendobj\n`;}
  const xref=Buffer.byteLength(output);
  output+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
export const PDF=makePdf();
// Container headers for signature/routing tests only. Actual playback uses separate real media.
export function isoHeader(brand:string):Buffer{const b=Buffer.alloc(24);b.writeUInt32BE(24);b.write('ftyp',4);b.write(brand,8);b.write(brand,16);b.write('isom',20);return b;}
export const MP4=isoHeader('isom'),MOV=isoHeader('qt  ');
export const WEBM=Buffer.from([0x1a,0x45,0xdf,0xa3,0x87,0x42,0x82,0x84,0x77,0x65,0x62,0x6d]);
export const MKV=Buffer.from([0x1a,0x45,0xdf,0xa3,0x8b,0x42,0x82,0x88,...Buffer.from('matroska')]);
export const OGV=Buffer.concat([Buffer.from('OggS\0'),Buffer.alloc(24),Buffer.from('\x80theora','latin1')]);
