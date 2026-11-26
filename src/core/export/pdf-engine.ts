import { jsPDF } from 'jspdf';

export function createPdf(orientation: 'portrait' | 'landscape', paper: 'a4' | 'letter') {
  return new jsPDF({ orientation, unit: 'mm', format: paper, compress: true });
}
