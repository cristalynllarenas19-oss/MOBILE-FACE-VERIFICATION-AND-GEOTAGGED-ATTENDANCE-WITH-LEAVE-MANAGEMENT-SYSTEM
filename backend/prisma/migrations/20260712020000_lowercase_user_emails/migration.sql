-- Login (AuthService.login) and account creation (EmployeesService.create)
-- never normalized case, and the `email` column has no case-insensitive
-- collation, so an account created as "Jane.Doe@Gmail.com" rejected a login
-- typed as "jane.doe@gmail.com" with "Invalid credentials" even though the
-- password was correct. The app-layer DTOs now lowercase email on input
-- (LoginDto, ForgotPasswordDto, VerifyResetOtpDto, CreateEmployeeDto,
-- UpdateEmployeeDto) — this backfills existing rows to match.
UPDATE users SET email = LOWER(email) WHERE email <> LOWER(email);
