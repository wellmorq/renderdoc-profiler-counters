Shader "Custom/Particles/SmokeUnlit"
{
    Properties { _MainTex("Particle Texture", 2D) = "white" {} _TintColor("Tint", Color) = (1,1,1,1)
                 _SoftParticlesNearFadeDistance("Soft Near", Float) = 1 _SoftParticlesFarFadeDistance("Soft Far", Float) = 2
                 _CameraFadingEnabled("Camera Fade", Float) = 0 _DistortionStrength("Distortion", Float) = 0 }
    SubShader { Tags { "Queue"="Transparent" } Blend SrcAlpha OneMinusSrcAlpha ZWrite Off
      Pass { HLSLPROGRAM
        #pragma vertex vert
        #pragma fragment frag
        TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
        CBUFFER_START(UnityPerMaterial) float4 _TintColor; float _SoftParticlesNearFadeDistance; float _SoftParticlesFarFadeDistance; float _CameraFadingEnabled; float _DistortionStrength; CBUFFER_END
        half4 frag(float2 uv : TEXCOORD0, float alpha : TEXCOORD1) : SV_Target {
            half4 t = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv) * SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, uv * 1.7 + 0.1);
            float a = saturate(1 - length(uv - 0.5) * 2) * alpha * _TintColor.a;
            return half4(t.rgb * _TintColor.rgb, a);
        }
      ENDHLSL } }
}
