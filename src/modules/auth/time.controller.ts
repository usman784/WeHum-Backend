import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public, SkipVersionGate } from '../../common/auth';

@ApiTags('Bootstrap')
@Controller('v1/time')
export class TimeController {
  /** Server time for countdown sync (also via socket time:sync). */
  @Public() @SkipVersionGate() @Get()
  now() { return { serverTime: Date.now() }; }
}
