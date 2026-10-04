#ifndef UNIVERSAL_REALTIME_LIGHTS_INCLUDED
#define UNIVERSAL_REALTIME_LIGHTS_INCLUDED
CBUFFER_START(AdditionalLights)
float4 _AdditionalLightsCount;
float4 _AdditionalLightsPosition[32];
float4 _AdditionalLightsColor[32];
CBUFFER_END
#endif
