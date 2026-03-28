#include <wiringPi.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>

static inline void emit_step(int step_pin, int pulse_us, int period_us) {
    int low_us = period_us - pulse_us;
    if (low_us < 1) low_us = 1;

    digitalWrite(step_pin, HIGH);
    delayMicroseconds(pulse_us);
    digitalWrite(step_pin, LOW);
    delayMicroseconds(low_us);
}

int main(int argc, char **argv) {
    const int STEP = 16;  // physical pin 16
    const int DIR  = 18;  // physical pin 18

    const double STEPS_PER_REV = 200.0; // your motor (typical 1.8°)

    double motor_hz  = 1.0;  // rev/s (negative = reverse direction)
    double total_sec = 3.0;
    double ramp_sec  = 0.5;
    int microsteps   = 16;   // default

    int pulse_us = 10;       // 5–10us is good for high step rates

    if (argc >= 2) motor_hz  = atof(argv[1]);
    if (argc >= 3) total_sec = atof(argv[2]);
    if (argc >= 4) ramp_sec  = atof(argv[3]);
    if (argc >= 5) microsteps = atoi(argv[4]);

    if (motor_hz == 0.0 || total_sec <= 0.0) {
        fprintf(stderr, "Usage: %s <motor_hz_rev_per_sec> <seconds> [ramp_sec] [microsteps]\n", argv[0]);
        fprintf(stderr, "  motor_hz: magnitude = speed (rev/s); negative = reverse (DIR LOW)\n");
        return 1;
    }
    if (ramp_sec < 0.0) ramp_sec = 0.0;
    if (microsteps < 1) microsteps = 1;

    if (2.0 * ramp_sec > total_sec) ramp_sec = total_sec / 2.0;
    double flat_sec = total_sec - 2.0 * ramp_sec;

    const double pulses_per_rev = STEPS_PER_REV * (double)microsteps;
    const double speed_hz = fabs(motor_hz);
    const double f_max = speed_hz * pulses_per_rev; // pulses/sec (always positive)

    const double f_start = 1.0; // avoid 0

    if (wiringPiSetupPhys() != 0) {
        fprintf(stderr, "wiringPiSetupPhys failed (run with sudo)\n");
        return 1;
    }

    pinMode(STEP, OUTPUT);
    pinMode(DIR, OUTPUT);
    digitalWrite(DIR, motor_hz < 0.0 ? LOW : HIGH);
    digitalWrite(STEP, LOW);

    // No ramp: constant speed
    if (ramp_sec <= 0.0 || f_max <= f_start) {
        int steps = (int)floor(f_max * total_sec + 0.5);
        int period_us = (int)floor(1000000.0 / f_max + 0.5);
        if (period_us < pulse_us + 1) period_us = pulse_us + 1;
        for (int i = 0; i < steps; i++) emit_step(STEP, pulse_us, period_us);
        return 0;
    }

    // Constant acceleration f(t)=f_start + a*t
    const double a = (f_max - f_start) / ramp_sec;

    const int n_accel = (int)floor(f_start * ramp_sec + 0.5 * a * ramp_sec * ramp_sec);
    const int n_flat  = (int)floor(f_max * flat_sec);

    // Accel: t(n) = (-f_start + sqrt(f_start^2 + 2*a*n))/a
    double prev_t = 0.0;
    for (int n = 1; n <= n_accel; n++) {
        double t = (-f_start + sqrt(f_start * f_start + 2.0 * a * (double)n)) / a;
        int period_us = (int)floor((t - prev_t) * 1000000.0 + 0.5);
        if (period_us < pulse_us + 1) period_us = pulse_us + 1;
        emit_step(STEP, pulse_us, period_us);
        prev_t = t;
    }

    // Flat
    if (n_flat > 0) {
        int period_us = (int)floor(1000000.0 / f_max + 0.5);
        if (period_us < pulse_us + 1) period_us = pulse_us + 1;
        for (int i = 0; i < n_flat; i++) emit_step(STEP, pulse_us, period_us);
    }

    // Decel: u(n) = (f_max - sqrt(f_max^2 - 2*a*n))/a
    double prev_u = 0.0;
    for (int n = 1; n <= n_accel; n++) {
        double inside = f_max * f_max - 2.0 * a * (double)n;
        if (inside < 0.0) inside = 0.0;
        double u = (f_max - sqrt(inside)) / a;
        int period_us = (int)floor((u - prev_u) * 1000000.0 + 0.5);
        if (period_us < pulse_us + 1) period_us = pulse_us + 1;
        emit_step(STEP, pulse_us, period_us);
        prev_u = u;
    }

    return 0;
}
