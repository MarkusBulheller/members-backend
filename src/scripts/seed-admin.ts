import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { DriversService } from '../drivers/drivers.service.js';
import { UsersService } from '../users/users.service.js';

/**
 * Promotes an existing user (identified by their Discord ID) straight to an approved admin,
 * bypassing the normal approval flow. Needed to bootstrap the very first admin account, since
 * a brand-new PENDING user has no admin yet to approve them.
 *
 * Sign in with Discord once first (so the PENDING user row exists), then run:
 *   npm run seed:admin -- --discordId=123456789012345678
 */
async function main() {
  const discordIdArg = process.argv.find((arg) => arg.startsWith('--discordId='));
  const discordId = discordIdArg?.split('=')[1];

  if (!discordId) {
    console.error('Usage: npm run seed:admin -- --discordId=<your discord user id>');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule);
  const usersService = app.get(UsersService);
  const driversService = app.get(DriversService);

  const user = await usersService.findByDiscordId(discordId);
  if (!user) {
    console.error(
      `No user found with discordId=${discordId}. Sign in with Discord at least once first, ` +
        'then re-run this script.',
    );
    await app.close();
    process.exit(1);
  }

  const promoted = await usersService.promoteToSeedAdmin(user.id);
  await driversService.createProfileForUser(promoted.id, promoted.discordGlobalName ?? promoted.discordUsername);
  console.log(`Promoted ${promoted.discordUsername} (${promoted.id}) to ADMIN / APPROVED.`);

  await app.close();
}

await main();
