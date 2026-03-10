// shaders/particle.vert — Particle system vertex shader (GLSL 330)
#version 330 core

layout (location = 0) in vec3 aPosition;
layout (location = 1) in vec3 aVelocity;
layout (location = 2) in vec4 aColor;
layout (location = 3) in float aLifetime;
layout (location = 4) in float aSize;

uniform mat4 uProjection;
uniform mat4 uView;
uniform float uTime;
uniform float uDeltaTime;
uniform vec3 uGravity;
uniform vec3 uWindForce;

out vec4 vColor;
out float vLifetimeNorm;
out float vSize;

void main() {
    float age = mod(uTime, aLifetime);
    float lifetimeNorm = clamp(age / aLifetime, 0.0, 1.0);

    // Apply simple physics integration
    vec3 acceleration = uGravity + uWindForce;
    vec3 velocity = aVelocity + acceleration * age;
    vec3 position = aPosition + velocity * age + 0.5 * acceleration * age * age;

    gl_Position = uProjection * uView * vec4(position, 1.0);

    // Fade out near end of lifetime
    float alpha = aColor.a * (1.0 - smoothstep(0.7, 1.0, lifetimeNorm));

    // Size decreases with age
    float sizeScale = mix(1.0, 0.1, lifetimeNorm);
    gl_PointSize = aSize * sizeScale / gl_Position.w;

    vColor = vec4(aColor.rgb, alpha);
    vLifetimeNorm = lifetimeNorm;
    vSize = aSize;
}
