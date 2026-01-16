// Employee count to band mapping utilities

export function mapEmployeeCountToBand(employeeStr: string): string | null {
  // Parse employee count from strings like "11-50", "51-200", "1,000+", "76"
  const cleanStr = employeeStr.replace(/,/g, '').replace(/\s+/g, '');
  
  // Handle range format like "11-50" or "51–200"
  const rangeMatch = cleanStr.match(/(\d+)[-–](\d+)/);
  if (rangeMatch) {
    const lower = parseInt(rangeMatch[1]);
    const upper = parseInt(rangeMatch[2]);
    const avg = Math.floor((lower + upper) / 2);
    return employeeCountToBand(avg);
  }
  
  // Handle "1000+" format
  const plusMatch = cleanStr.match(/(\d+)\+/);
  if (plusMatch) {
    const count = parseInt(plusMatch[1]);
    return employeeCountToBand(count);
  }
  
  // Handle plain number
  const numMatch = cleanStr.match(/(\d+)/);
  if (numMatch) {
    return employeeCountToBand(parseInt(numMatch[1]));
  }
  
  return null;
}

export function employeeCountToBand(count: number): string {
  if (count <= 1) return '0-1 Employees';
  if (count <= 10) return '2-10 Employees';
  if (count <= 50) return '11-50 Employees';
  if (count <= 200) return '51-200 Employees';
  if (count <= 500) return '201-500 Employees';
  if (count <= 1000) return '501-1,000 Employees';
  if (count <= 5000) return '1,001-5,000 Employees';
  if (count <= 10000) return '5,001-10,000 Employees';
  return '10,001+ Employees';
}
