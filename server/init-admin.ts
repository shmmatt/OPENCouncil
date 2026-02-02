import bcrypt from "bcryptjs";
import { storage } from "./storage";

export async function ensureAdminExists(): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.warn("ADMIN_EMAIL or ADMIN_PASSWORD not set - skipping admin initialization");
    return;
  }

  try {
    // Check if admin already exists
    const existingAdmin = await storage.getAdminByEmail(adminEmail);
    
    if (!existingAdmin) {
      // Hash password and create admin
      const passwordHash = await bcrypt.hash(adminPassword, 10);
      await storage.createAdmin({
        email: adminEmail,
        passwordHash,
      });
      console.log(`Admin account created for: ${adminEmail}`);
    } else {
      console.log(`Admin account already exists for: ${adminEmail}`);
    }
  } catch (error) {
    console.error("Error initializing admin:", error);
  }
}
