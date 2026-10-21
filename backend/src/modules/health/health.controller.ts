import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';

@Controller('health')
export class HealthController {
  constructor(private readonly orm: MikroORM) {}

  @Get()
  async check() {
    try {
      await this.orm.em.getConnection().execute('select 1');
      return { status: 'ok', database: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'unavailable' });
    }
  }
}
