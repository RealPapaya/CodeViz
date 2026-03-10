// shaders/particle.frag — Particle system fragment shader
#version 330 core

in vec4 vColor;
in float vLifetimeNorm;
in float vSize;

out vec4 fragColor;

uniform sampler2D uSpriteTex;
uniform bool uUseSprite;
uniform float uGlow;

vec3 applyGlow(vec3 color, float glow) {
    float brightness = dot(color, vec3(0.2126, 0.7152, 0.0722));
    vec3 glowColor = color * brightness * glow;
    return color + glowColor;
}

void main() {
    vec2 uv = gl_PointCoord;
    float dist = length(uv - vec2(0.5));

    // Soft circle mask
    float alpha = smoothstep(0.5, 0.45, dist);
    if (alpha < 0.01) discard;

    vec4 texColor = vec4(1.0);
    if (uUseSprite) {
        texColor = texture(uSpriteTex, uv);
    }

    vec3 finalColor = applyGlow(vColor.rgb * texColor.rgb, uGlow);
    float finalAlpha = vColor.a * texColor.a * alpha;

    fragColor = vec4(finalColor, finalAlpha);
}
