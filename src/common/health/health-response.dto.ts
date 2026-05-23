export class HealthServicesDto {
  redis!: 'up' | 'down';
}

export class HealthIngestionDto {
  active!: boolean;
}

export class HealthResponseDto {
  status!: 'ok';
  timestamp!: string;
  services!: HealthServicesDto;
  ingestion!: HealthIngestionDto;
}
