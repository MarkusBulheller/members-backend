import { Global, Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';

/** JwtAuthGuard (AuthGuard('jwt')) needs PassportModule's provider available in the injector
 * scope of every module whose controllers use it — global-scoping it here means DriversModule,
 * EventsModule, CarsModule, LiveriesModule, and UsersModule don't each need their own import. */
@Global()
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  exports: [PassportModule],
})
export class AuthGuardsModule {}
