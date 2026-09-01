import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'node:path';
import { AchievementsModule } from './achievements/achievements.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CarTrackSetupsModule } from './car-track-setups/car-track-setups.module.js';
import { CarsModule } from './cars/cars.module.js';
import { AuthGuardsModule } from './common/auth-guards.module.js';
import { ContactInquiriesModule } from './contact-inquiries/contact-inquiries.module.js';
import { DriversModule } from './drivers/drivers.module.js';
import { EventsModule } from './events/events.module.js';
import { IracingModule } from './iracing/iracing.module.js';
import { LiveriesModule } from './liveries/liveries.module.js';
import { RaceResultsModule } from './race-results/race-results.module.js';
import { StatsModule } from './stats/stats.module.js';
import { TeamHighlightsModule } from './team-highlights/team-highlights.module.js';
import { TracksModule } from './tracks/tracks.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        url: configService.getOrThrow<string>('DATABASE_URL'),
        autoLoadEntities: true,
        // Fine for early development where the schema is still moving; must be replaced
        // with real migrations before this ever points at a production database.
        synchronize: configService.get<string>('NODE_ENV', 'development') !== 'production',
      }),
    }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
    }),
    AuthGuardsModule,
    UsersModule,
    AuthModule,
    ContactInquiriesModule,
    DriversModule,
    AchievementsModule,
    EventsModule,
    CarsModule,
    LiveriesModule,
    IracingModule,
    TracksModule,
    CarTrackSetupsModule,
    RaceResultsModule,
    StatsModule,
    TeamHighlightsModule,
  ],
})
export class AppModule {}
